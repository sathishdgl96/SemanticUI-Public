r"""Execute: the MDX Excel sends, answered from the semantic query builder.

The statement-less Execute is BeginSession's vehicle and answers with the
empty-namespace root. Real statements go through the mdx parser, become one
or more semantic queries on the CALLER'S OWN connection, and come back as
the mddataset shape Excel accepts (see dataset.py).

The engine supports what Excel's pivot engine emits, learned from the wire:
up to two axes, each carrying a measure set and/or ONE attribute-hierarchy
drill; WHERE tuples and subselects as filters. An axis with an All-member
drill answers the All tuple from a coarser aggregate query -- one query per
distinct grouping the axes require (at most four), all on one connection.
"""

from app.config import get_settings
from app.errors import ApiError
from app.semantic.query import SemanticQueryRequest, build_semantic_sql
from app.snowflake import gateway
from app.xmla import dataset
from app.xmla.mdx import HierSpec, MdxQuery, MdxUnsupported, MemberRef, parse_mdx

#: All-member DisplayInfo: DRILLED_DOWN flag plus the child count.
_DRILLED = 0x10000


def empty_dataset() -> str:
    """The canonical answer to a statement-less Execute.

    Real SSAS replies with the EMPTY-namespace root, not an empty mddataset;
    ADOMD.NET rejects the mddataset variant as "unrecognizable" (verified on
    the wire, 2026-08-18), so the distinction is load-bearing.
    """
    return (
        '<ExecuteResponse xmlns="urn:schemas-microsoft-com:xml-analysis">'
        "<return>"
        '<root xmlns="urn:schemas-microsoft-com:xml-analysis:empty"/>'
        "</return></ExecuteResponse>"
    )


# ------------------------------------------------------- axis interpretation

def _classify(entries, detail) -> list[HierSpec]:
    """Axis entries from the parser -> [measures spec?] + [field specs]."""
    measures: list[str] = []
    fields: dict[tuple[str, str], HierSpec] = {}

    def field_spec(table: str, name: str) -> HierSpec:
        key = (table.upper(), name.upper())
        if key not in fields:
            fields[key] = HierSpec(
                kind="drill", table=table, hier_field=name,
                include_all=False, children_of_all=False,
            )
        return fields[key]

    def on_member(ref: MemberRef, drilled: bool) -> None:
        if ref.is_measure:
            if len(ref.parts) != 2:
                raise MdxUnsupported(f"measure ref {ref.parts}")
            measures.append(ref.parts[1])
            return
        if len(ref.parts) < 2:
            raise MdxUnsupported(f"member ref {ref.parts}")
        table, name = ref.parts[0], ref.parts[1]
        spec = field_spec(table, name)
        rest = ref.parts[2:]
        if ref.suffix == "CHILDREN":
            spec.children_of_all = True
            return
        if not rest or (len(rest) == 1 and rest[0].upper() == "ALL"):
            spec.include_all = True
            if drilled:
                spec.children_of_all = True
            return
        if len(rest) == 1:
            spec.members.append(rest[0])
            return
        raise MdxUnsupported(f"deep member path {ref.parts}")

    def walk(entry, drilled=False):
        if isinstance(entry, MemberRef):
            on_member(entry, drilled)
        elif isinstance(entry, tuple) and entry[0] == "drill":
            on_member(entry[1], True)
        elif isinstance(entry, tuple) and entry[0] == "cross":
            for arg in entry[1]:
                for e in arg:
                    walk(e, drilled)
        else:
            raise MdxUnsupported(f"unsupported axis entry {entry!r}")

    for entry in entries:
        walk(entry)

    specs: list[HierSpec] = []
    if measures:
        specs.append(HierSpec(kind="measures", measures=measures))
    specs.extend(fields.values())
    return specs


def _valid_measures(detail: dict, names: list[str]) -> list[str]:
    known = {f"{m['table']}.{m['name']}".upper(): f"{m['table']}.{m['name']}"
             for m in detail.get("metrics", [])}
    out = []
    for n in names:
        if n.upper() not in known:
            raise ApiError("XMLA_MDX", 400, f"unknown measure {n!r}")
        out.append(known[n.upper()])
    return out


# ---------------------------------------------------------------- execution

class _Engine:
    def __init__(self, session, view: dict, detail: dict, q: MdxQuery):
        self.session = session
        self.view = view
        self.detail = detail
        self.q = q
        self._results: dict[frozenset, dict] = {}
        self.filters: list[dict] = []
        self.slicer_members: list[dict] = []
        self.measures: list[str] = []

    # -- helpers ----------------------------------------------------------
    def _run(self, group_fields: list[HierSpec]) -> dict:
        """Aggregate metrics grouped by these fields; cached per grouping.
        Returns {tuple(dim values): [metric values...]}, insertion-ordered.
        """
        key = frozenset((s.table.upper(), s.hier_field.upper()) for s in group_fields)
        if key in self._results:
            return self._results[key]
        dims = [f"{s.table}.{s.hier_field}" for s in group_fields]
        request = SemanticQueryRequest.model_validate({
            "database": self.view["database"],
            "schema": self.view["schema"],
            "view": self.view["name"],
            "dimensions": dims,
            "metrics": self.measures,
            "filters": self.filters,
            "orderBy": [{"field": d, "direction": "asc"} for d in dims],
            "limit": None,
        })
        sql, params, limit = build_semantic_sql(
            self.detail, request, max_rows=get_settings().export_row_cap
        )
        result = gateway.run_query(
            self.session.conn, sql, max_rows=limit, params=params
        )
        n = len(dims)
        table = {}
        for row in result.rows:
            table[tuple(row[:n])] = list(row[n:])
        self._results[key] = table
        return table

    # -- member builders --------------------------------------------------
    @staticmethod
    def _hier_uname(spec: HierSpec) -> str:
        return f"[{spec.table}].[{spec.hier_field}]"

    def _all_member(self, spec: HierSpec, child_count: int) -> dict:
        u = self._hier_uname(spec)
        return {
            "hierarchy": u,
            "uname": f"{u}.[All]",
            "caption": "All",
            "lname": f"{u}.[(All)]",
            "lnum": 0,
            "display_info": _DRILLED | min(child_count, 0xFFFF),
        }

    def _leaf_member(self, spec: HierSpec, value) -> dict:
        u = self._hier_uname(spec)
        caption = "" if value is None else str(value)
        return {
            "hierarchy": u,
            "uname": f"{u}.&[{caption}]",
            "caption": caption,
            "lname": f"{u}.[{spec.hier_field}]",
            "lnum": 1,
            "display_info": 0,
            "properties": {
                "PARENT_UNIQUE_NAME": f"{u}.[All]",
                "HIERARCHY_UNIQUE_NAME": u,
            },
        }

    def _measure_member(self, name: str) -> dict:
        return {
            "hierarchy": "[Measures]",
            "uname": f"[Measures].[{name}]",
            "caption": name.split(".", 1)[-1],
            "lname": "[Measures].[MeasuresLevel]",
            "lnum": 0,
            "display_info": 0,
        }

    # -- the run ----------------------------------------------------------
    def execute(self) -> str:
        q = self.q
        axis_specs = [
            _classify(entries, self.detail) if entries else []
            for entries in q.axes
        ]

        # WHERE and subselects: measures select cells, members filter rows.
        where_measures: list[str] = []
        for ref in q.slicer:
            if ref.is_measure:
                where_measures.append(ref.parts[1])
            else:
                self._member_filter(ref)
        for entries in q.subselect_filters:
            for spec in _classify(entries, self.detail):
                if spec.kind == "measures":
                    continue
                if spec.members:
                    self.filters.append({
                        "id": f"mdx{len(self.filters)}",
                        "field": f"{spec.table}.{spec.hier_field}",
                        "op": "is",
                        "values": spec.members,
                    })

        axis_measures = [m for specs in axis_specs
                         for s in specs if s.kind == "measures"
                         for m in s.measures]
        # No measure anywhere means a member-list query: run it dimension-
        # only and answer no cells. Inventing a default measure breaks the
        # moment it cannot legally group by the queried field.
        self.measures = _valid_measures(
            self.detail, axis_measures or where_measures
        )

        # Build each axis's tuple list plus a resolver from tuple index to
        # (leaf-field assignment, measure index).
        axes_out = []       # (name, hierarchy names, tuples)
        resolvers = []      # per axis: list of (assignments dict, measure)
        for index, specs in enumerate(axis_specs):
            name = f"Axis{index}"
            field_specs = [s for s in specs if s.kind != "measures"]
            has_measures = any(s.kind == "measures" for s in specs)
            measure_list = list(range(len(self.measures))) if has_measures else [None]
            if len(field_specs) > 1:
                raise MdxUnsupported("more than one hierarchy per axis")
            members = []    # (member dict, assignment)
            if field_specs:
                spec = field_specs[0]
                values = list(self._run([spec]).keys())
                if spec.include_all:
                    members.append((self._all_member(spec, len(values)), None))
                if spec.children_of_all:
                    for (value,) in values:
                        members.append(
                            (self._leaf_member(spec, value), {spec_key(spec): value})
                        )
                elif spec.members:
                    have = {str(v[0]).upper(): v[0] for v in values}
                    for m in spec.members:
                        value = have.get(m.upper(), m)
                        members.append(
                            (self._leaf_member(spec, value), {spec_key(spec): value})
                        )
            else:
                members.append((None, None))

            tuples, resolver, hier_names = [], [], []
            for member, assignment in members:
                for mi in measure_list:
                    tup = []
                    if member is not None:
                        tup.append(member)
                    if mi is not None:
                        tup.append(self._measure_member(self.measures[mi]))
                    if not tup:
                        continue
                    tuples.append(tup)
                    resolver.append((assignment, mi))
            if not tuples:
                continue
            if field_specs:
                hier_names.append((
                    self._hier_uname(field_specs[0]),
                    ["PARENT_UNIQUE_NAME", "HIERARCHY_UNIQUE_NAME"],
                ))
            if has_measures:
                hier_names.append(("[Measures]", []))
            axes_out.append((name, hier_names, tuples))
            resolvers.append(resolver)

        # Slicer: WHERE members, else the effective measure if there is one.
        slicer_tuple = list(self.slicer_members)
        if not axis_measures and self.measures:
            slicer_tuple.append(self._measure_member(self.measures[0]))
        slicer_hiers = [(m["hierarchy"], []) for m in slicer_tuple]
        # An empty slicer is an empty <Tuples/>, never an empty <Tuple/> --
        # the mddataset schema requires a Member in every Tuple, and both
        # ADOMD and Excel refuse the whole response over it (verified by
        # validating our own wire capture against the embedded XSD).
        axes_out.append(
            ("SlicerAxis", slicer_hiers, [slicer_tuple] if slicer_tuple else [])
        )

        # Cells: iterate the cartesian product of axis tuples, row-major
        # with Axis0 fastest -- CellOrdinal = i1 * len(axis0) + i0.
        cells = []
        if not self.measures:
            pass  # member-list query: tuples only, no cells
        elif not resolvers:
            table = self._run([])
            value = next(iter(table.values()), [None, None])[0]
            if value is not None:
                cells.append((0, value))
        else:
            shape = [len(r) for r in resolvers]
            total = 1
            for n in shape:
                total *= n
            field_spec_map = {}
            for specs in axis_specs:
                for s in specs:
                    if s.kind != "measures":
                        field_spec_map[spec_key(s)] = s
            for ordinal in range(total):
                rem, coords = ordinal, []
                for n in shape:
                    coords.append(rem % n)
                    rem //= n
                assignment: dict = {}
                measure_index = 0
                skip = False
                for axis_i, coord in enumerate(coords):
                    a, mi = resolvers[axis_i][coord]
                    if a:
                        assignment.update(a)
                    if mi is not None:
                        measure_index = mi
                group = [field_spec_map[k] for k in assignment]
                table = self._run(group)
                key = tuple(assignment[spec_key(s)] for s in group)
                row = table.get(key)
                if row is None:
                    continue
                value = row[measure_index]
                if value is None:
                    continue
                cells.append((ordinal, value))

        cube = self.q.cube
        return dataset.mddataset(cube, axes_out, cells)

    def _member_filter(self, ref: MemberRef) -> None:
        if len(ref.parts) < 3:
            return  # a bare hierarchy in WHERE means its All member: no-op
        table, name, value = ref.parts[0], ref.parts[1], ref.parts[2]
        if value.upper() == "ALL":
            return
        self.filters.append({
            "id": f"mdx{len(self.filters)}",
            "field": f"{table}.{name}",
            "op": "is",
            "values": [value],
        })
        u = f"[{table}].[{name}]"
        self.slicer_members.append({
            "hierarchy": u,
            "uname": f"{u}.&[{value}]",
            "caption": value,
            "lname": f"{u}.[{name}]",
            "lnum": 1,
            "display_info": 0,
        })


def spec_key(spec: HierSpec) -> tuple[str, str]:
    return (spec.table.upper(), spec.hier_field.upper())


def handle_execute(session, request) -> str:
    statement = (request.statement or "").strip()
    if not statement:
        return empty_dataset()
    try:
        q = parse_mdx(statement)
    except MdxUnsupported as exc:
        raise ApiError("XMLA_MDX", 400, f"unsupported MDX: {exc}") from exc

    view = None
    for v in session.list_views():
        from app.xmla.discover import cube_name

        if cube_name(v).upper() == q.cube.upper():
            view = v
            break
    if view is None:
        raise ApiError("XMLA_MDX", 404, f"unknown cube {q.cube!r}")
    detail = session.describe(view["database"], view["schema"], view["name"])
    return _Engine(session, view, detail, q).execute()
