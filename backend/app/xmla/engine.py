"""The MDX execution engine: classified axes -> queries -> mddataset.

One aggregate query per distinct grouping the axes require (at most
four), all on the caller's own connection, cached per grouping for the
statement's lifetime. The wire rules the engine embodies:

* Cells iterate the cartesian product of axis tuples row-major with
  Axis0 FASTEST: CellOrdinal = i1 * len(axis0) + i0.
* NON EMPTY means a combination of leaf members the data never produces
  contributes no tuple at all.
* An empty slicer is an empty <Tuples/>, never an empty <Tuple/> -- the
  mddataset schema requires a Member in every Tuple, and both ADOMD and
  Excel refuse the whole response over it.
* Per-tuple filters (Excel's "uncheck this child under this parent
  only") survive as (fields) IN ((values), ...) predicates so Snowflake
  recomputes visual totals like a native cube.
"""

from app.config import get_settings
from app.errors import ApiError
from app.semantic.query import SemanticQueryRequest, build_semantic_sql
from app.snowflake import gateway
from app.xmla import dataset
from app.xmla.classify import _classify
from app.xmla.discover import path_unique_name, user_hierarchies
from app.xmla.mdx import HierSpec, MdxQuery, MemberRef
from app.xmla.members import _DRILLED, MemberBuilders


def _valid_measures(detail: dict, names: list[str]) -> list[str]:
    known = {f"{m['table']}.{m['name']}".upper(): f"{m['table']}.{m['name']}"
             for m in detail.get("metrics", [])}
    out = []
    for n in names:
        if n.upper() not in known:
            raise ApiError("XMLA_MDX", 400, f"unknown measure {n!r}")
        out.append(known[n.upper()])
    return out


class _Engine(MemberBuilders):
    def __init__(self, session, view: dict, detail: dict, q: MdxQuery):
        self.session = session
        self.view = view
        self.detail = detail
        self.q = q
        #: User hierarchies visible to this session, keyed (HOME, NAME).
        self.user_hiers = {
            (h["home"].upper(), h["name"].upper()): h
            for h in user_hierarchies(session, view)
        }
        #: Per-level stand-in specs, so hierarchy path members share the
        #: same grouping and cell machinery as plain attribute fields.
        self._surrogates: dict[tuple, HierSpec] = {}
        self._results: dict[frozenset, dict] = {}
        self.filters: list[dict] = []
        #: ([field, ...], [[value, ...], ...]) rows kept by per-tuple
        #: filters -- Excel's "uncheck this child under this parent only".
        self.include_combos: list = []
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
            self.detail, request, max_rows=get_settings().export_row_cap,
            include_combos=self.include_combos,
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

    def _surrogate(self, table: str, name: str) -> HierSpec:
        key = (table.upper(), name.upper())
        if key not in self._surrogates:
            self._surrogates[key] = HierSpec(
                kind="drill", table=table, hier_field=name,
                include_all=False, children_of_all=False,
            )
        return self._surrogates[key]

    # -- the run ----------------------------------------------------------
    def execute(self) -> str:
        q = self.q
        axis_specs = [
            _classify(entries, self.detail, exists_filters=self.filters,
                      user_hiers=self.user_hiers)
            if entries else []
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
            # Tuple entries keep their combination: they become one
            # (fields) IN ((values), ...) predicate, which is what makes
            # "1-URGENT unchecked under F but kept under O" reach Snowflake
            # as a fact rather than dissolving into two independent lists.
            combos: dict[tuple, list[list]] = {}
            plain = []
            for entry in entries:
                if isinstance(entry, tuple) and entry[0] == "tuple":
                    refs = [e for e in entry[1]
                            if isinstance(e, MemberRef) and not e.is_measure
                            and len(e.parts) == 3]
                    if len(refs) >= 2:
                        key = tuple(f"{r.parts[0]}.{r.parts[1]}" for r in refs)
                        combos.setdefault(key, []).append(
                            [r.parts[2] for r in refs]
                        )
                        continue
                    plain.extend(refs)
                    continue
                plain.append(entry)
            for key, rows in combos.items():
                self.include_combos.append((list(key), rows))
            for spec in _classify(plain, self.detail, user_hiers=self.user_hiers):
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
        # (leaf-field assignment, measure index). An axis may carry several
        # hierarchies (Excel's CrossJoin of drilldowns): its tuples are the
        # cross product of each hierarchy's member list, first hierarchy
        # outermost, exactly CrossJoin's enumeration order. Combinations of
        # leaf members that the data never produces are pruned, which is
        # what NON EMPTY means for the shapes Excel sends.
        from itertools import product

        axes_out = []       # (name, hierarchy names, tuples)
        resolvers = []      # per axis: list of (assignments dict, measure)
        for index, specs in enumerate(axis_specs):
            name = f"Axis{index}"
            field_specs = [s for s in specs if s.kind != "measures"]
            has_measures = any(s.kind == "measures" for s in specs)
            measure_list = list(range(len(self.measures))) if has_measures else [None]

            per_spec = []   # per hierarchy: [(member dict, assignment|None)]
            for spec in field_specs:
                if spec.kind == "userhier":
                    per_spec.append(self._userhier_members(spec))
                    continue
                values = list(self._run([spec]).keys())
                members = []
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
                per_spec.append(members)

            # DisplayInfo is how the server TELLS Excel each member's
            # drill state (0x10000 = drilled down); Excel rebuilds its own
            # bookkeeping from it after every response. Without the flag a
            # collapse is forgotten by the very next gesture (observed
            # live: collapsing O silently re-expanded F).
            for j, spec in enumerate(field_specs[:-1]):
                child = field_specs[j + 1]
                for member, assignment in per_spec[j]:
                    if assignment is None:
                        continue
                    value = assignment.get(spec_key(spec))
                    expanded = _parent_drilled(child, spec, value)
                    member["display_info"] = (
                        (_DRILLED if expanded else 0) | 1000
                    )

            tuples, resolver, hier_names = [], [], []
            field_spec_by_key = {spec_key(s): s for s in field_specs}
            for spec in field_specs:
                if spec.kind == "userhier":
                    for t, n in spec.levels:
                        field_spec_by_key[(t.upper(), n.upper())] = self._surrogate(t, n)
            for combo in (product(*per_spec) if per_spec else [()]):
                assignment: dict = {}
                for _, a in combo:
                    if a:
                        assignment.update(a)
                if not _drill_allowed(field_specs, assignment):
                    continue
                # NON EMPTY: a combination of leaf members that never occurs
                # together in the data contributes no tuple at all.
                if len(assignment) > 1:
                    group = [field_spec_by_key[k] for k in assignment]
                    if tuple(assignment[spec_key(s)] for s in group) not in self._run(group):
                        continue
                for mi in measure_list:
                    tup = [m for m, _ in combo]
                    if mi is not None:
                        tup.append(self._measure_member(self.measures[mi]))
                    if not tup:
                        continue
                    tuples.append(tup)
                    resolver.append((assignment, mi))
            if not tuples:
                continue
            for spec in field_specs:
                hier_names.append((
                    self._hier_uname(spec),
                    ["PARENT_UNIQUE_NAME", "HIERARCHY_UNIQUE_NAME"],
                ))
            # (user hierarchies share the same shape: unique name + the
            # two declared member properties)
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
                    if s.kind == "userhier":
                        for t, n in s.levels:
                            field_spec_map[(t.upper(), n.upper())] = self._surrogate(t, n)
                    elif s.kind != "measures":
                        field_spec_map[spec_key(s)] = s
            for ordinal in range(total):
                rem, coords = ordinal, []
                for n in shape:
                    coords.append(rem % n)
                    rem //= n
                assignment: dict = {}
                measure_index = 0
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
        uh = self.user_hiers.get((table.upper(), name.upper()))
        if uh is not None:
            path = tuple(ref.parts[2:])
            if len(path) == 1 and not ref.keyed[2] and path[0].upper() in ("ALL", "(ALL)"):
                return
            for i, v in enumerate(path):
                if i >= len(uh["levels"]):
                    break
                t, n = uh["levels"][i]
                self.filters.append({
                    "id": f"mdx{len(self.filters)}",
                    "field": f"{t}.{n}",
                    "op": "is",
                    "values": [v],
                })
            hu = f"[{uh['home']}].[{uh['name']}]"
            self.slicer_members.append({
                "hierarchy": hu,
                "uname": path_unique_name(uh["home"], uh["name"], path),
                "caption": str(path[-1]),
                "lname": f"{hu}.[{uh['levels'][min(len(path), len(uh['levels'])) - 1][1]}]",
                "lnum": len(path),
                "display_info": 0,
            })
            return
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


def _parent_drilled(child: HierSpec, parent: HierSpec, value) -> bool:
    """Whether this parent member's children are shown, per the drill
    constraints DrilldownMember put on the child hierarchy."""
    if child.parent_key is None or child.parent_key != spec_key(parent):
        return True
    v = "" if value is None else str(value).upper()
    if child.parent_include is not None and v not in {
        m.upper() for m in child.parent_include
    }:
        return False
    return v not in {m.upper() for m in child.parent_exclude}


def _drill_allowed(field_specs, assignment: dict) -> bool:
    """False for a tuple whose leaf members sit under a collapsed parent.

    A constrained hierarchy's leaves appear only where the DrilldownMember
    drill set said they should. The parent at its All member always keeps
    its children -- those are the cross-hierarchy subtotal rows the client
    has always been sent and tolerates.
    """
    for spec in field_specs:
        if spec.parent_key is None or spec_key(spec) not in assignment:
            continue
        parent_value = assignment.get(spec.parent_key)
        if parent_value is None:
            continue
        value = str(parent_value).upper()
        if spec.parent_include is not None and value not in {
            m.upper() for m in spec.parent_include
        }:
            return False
        if value in {m.upper() for m in spec.parent_exclude}:
            return False
    return True
