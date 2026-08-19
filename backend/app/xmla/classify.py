"""Axis interpretation: the parser's set expressions -> HierSpec per hierarchy.

Everything Excel can put on an axis -- drilldowns, CrossJoins, tuples,
DrilldownMember with its {-{m}} complements, Exists() scoping -- reduces to
one HierSpec per attribute or user hierarchy plus an optional measures spec.
The reductions encode protocol facts learned on the wire:

* A LEAF's .Children is the EMPTY set; answering the level again is how a
  filter dropdown shows the same top values on every expansion.
* Level.Members is that level's members FLAT, never a drilled tree.
* A user-hierarchy drill needs no target hierarchy: a path expands into its
  own next level, and must be handled before the attribute early-return or
  a same-hierarchy DrilldownMember is silently lost.
"""

from app.xmla.mdx import HierSpec, MdxUnsupported, MemberRef


def _is_all_ref(ref: MemberRef) -> bool:
    """True for [T].[H].[All] -- the scoping member that means NO constraint.

    Excel sends it as the second argument of Exists() whenever nothing is
    selected. Treated as a value it filters on the literal string "All"
    and empties the result, which is how a filter dropdown ends up blank.
    A KEYED segment (`.&[All]`) is a real member whose caption is "All",
    so the key flag is what separates the two.
    """
    if len(ref.parts) != 3:
        return False
    keyed = ref.keyed[2] if len(ref.keyed) > 2 else False
    return not keyed and ref.parts[2].upper() in ("ALL", "(ALL)")


def _classify(entries, detail, exists_filters: list | None = None,
              user_hiers: dict | None = None,
              path_sink: list | None = None) -> list[HierSpec]:
    """Axis entries from the parser -> [measures spec?] + [field specs].

    `exists_filters`, when given, collects equality filters contributed by
    Exists(setA, setB): B's members constrain the whole query, which is
    exactly what scopes a dropdown's child level to the expanded member.

    `path_sink` collects (hierarchy, path) selections from Exists over a
    USER hierarchy. They cannot become per-field filters: two branches
    would widen into their cartesian (EUROPE/FRANCE + ASIA/JAPAN would
    also admit EUROPE/JAPAN), so the engine turns them into one tuple-IN.
    """
    measures: list[str] = []
    fields: dict[tuple[str, str], HierSpec] = {}

    def field_spec(table: str, name: str) -> HierSpec:
        key = (table.upper(), name.upper())
        if key not in fields:
            uh = (user_hiers or {}).get(key)
            if uh is not None:
                fields[key] = HierSpec(
                    kind="userhier", table=uh["home"], hier_field=uh["name"],
                    include_all=False, children_of_all=False,
                    levels=list(uh["levels"]),
                )
            else:
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
        if spec.kind == "userhier":
            is_all = (len(rest) == 1 and not ref.keyed[2]
                      and rest[0].upper() in ("ALL", "(ALL)"))
            path = () if (not rest or is_all) else tuple(rest)
            if ref.suffix == "CHILDREN":
                spec.drilled_paths.add(path)
                if not path:
                    spec.include_all = True
                return
            if ref.suffix == "MEMBERS":
                if not rest:
                    spec.include_all = True
                    spec.drilled_paths.add(())
                elif is_all:
                    spec.include_all = True
                else:
                    # Level.Members: exactly that level's members, FLAT.
                    # Returning a drilled tree here is how the dropdown
                    # ended up showing one mixed level instead of each
                    # level on demand.
                    depth = next(
                        (i for i, (_, n) in enumerate(spec.levels, start=1)
                         if n.upper() == rest[0].upper()),
                        0,
                    )
                    if depth:
                        spec.flat_depths.add(depth)
                return
            if not path:
                spec.include_all = True
                if drilled:
                    spec.drilled_paths.add(())
                return
            # DrilldownMember's drill set re-walks members the base axis
            # already carried; without the guard the member is emitted
            # twice and the pivot grows duplicate rows.
            if path not in spec.member_paths:
                spec.member_paths.append(path)
            if drilled:
                spec.drilled_paths.add(path)
            return
        if ref.suffix == "CHILDREN":
            # Only the All member has children in a two-level attribute
            # hierarchy. A LEAF's .Children is the empty set -- answering
            # the whole level again is how a filter dropdown ends up
            # showing the same top-level values on every expansion.
            if not rest or (len(rest) == 1 and rest[0].upper() == "ALL"):
                spec.children_of_all = True
            return
        if ref.suffix == "MEMBERS":
            # [T].[F].Members = All + leaves; [T].[F].[F].Members = the leaf
            # LEVEL's members; [T].[F].[(All)].Members = just the All member.
            if not rest:
                spec.include_all = True
                spec.children_of_all = True
            elif rest[0].upper() == name.upper():
                spec.children_of_all = True
            elif rest[0].upper() in ("(ALL)", "ALL"):
                spec.include_all = True
            else:
                raise MdxUnsupported(f"members of level {ref.parts}")
            return
        if not rest or (len(rest) == 1 and rest[0].upper() == "ALL"):
            spec.include_all = True
            if drilled:
                spec.children_of_all = True
            return
        if len(rest) == 1:
            # Same de-duplication as user-hierarchy paths above: a member
            # named in both the base set and the drill set is ONE member.
            if not any(m.upper() == rest[0].upper() for m in spec.members):
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
        elif isinstance(entry, tuple) and entry[0] == "drillmember":
            on_drillmember(entry[1], entry[2], entry[3])
        elif isinstance(entry, tuple) and entry[0] == "tuple":
            for e in entry[1]:
                walk(e, drilled)
        elif isinstance(entry, tuple) and entry[0] == "exists":
            for e in entry[1]:
                walk(e, drilled)
            by_field: dict[tuple[str, str], list[str]] = {}
            for e in entry[2]:
                if not (isinstance(e, MemberRef) and not e.is_measure
                        and len(e.parts) >= 3):
                    continue
                if _is_all_ref(e):
                    continue  # scoping to All constrains nothing
                uh = (user_hiers or {}).get((e.parts[0].upper(), e.parts[1].upper()))
                if uh is not None:
                    path = tuple(e.parts[2:])[: len(uh["levels"])]
                    if path and path_sink is not None:
                        path_sink.append((uh, path))
                    continue
                if len(e.parts) == 3:
                    by_field.setdefault((e.parts[0], e.parts[1]), []).append(e.parts[2])
            if exists_filters is not None:
                for (table, name), values in by_field.items():
                    exists_filters.append({
                        "id": f"exists{len(exists_filters)}",
                        "field": f"{table}.{name}",
                        "op": "is",
                        "values": values,
                    })
        else:
            raise MdxUnsupported(f"unsupported axis entry {entry!r}")

    def on_drillmember(base, drill, target) -> None:
        """DrilldownMember(base, drillSet, hierarchy): Excel's collapse.

        The base tuples walk in as usual; the target hierarchy gains its
        leaf members -- but only under the parents the drill set names.
        {-{m}} (the complement) means "expand everything except m", the
        shape Excel sends when one group row is collapsed.
        """
        for e in base:
            walk(e)
        # User-hierarchy drills need no target: a path expands into its OWN
        # next level. Handle them before the attribute early-return, or a
        # same-hierarchy drill (no third argument) is silently lost.
        for e in drill:
            if (isinstance(e, MemberRef) and not e.is_measure
                    and len(e.parts) >= 3
                    and (user_hiers or {}).get(
                        (e.parts[0].upper(), e.parts[1].upper())) is not None):
                field_spec(e.parts[0], e.parts[1]).drilled_paths.add(
                    tuple(e.parts[2:])
                )
            elif isinstance(e, tuple) and e[0] == "except":
                for inner in e[1]:
                    if (isinstance(inner, MemberRef) and not inner.is_measure
                            and len(inner.parts) >= 3
                            and (user_hiers or {}).get(
                                (inner.parts[0].upper(),
                                 inner.parts[1].upper())) is not None):
                        uspec = field_spec(inner.parts[0], inner.parts[1])
                        path = tuple(inner.parts[2:])
                        uspec.undrilled_paths.add(path)
                        uspec.drilled_depths.add(len(path))
        target_ref = next(
            (e for e in target
             if isinstance(e, MemberRef) and not e.is_measure and len(e.parts) == 2),
            None,
        )
        if target_ref is None:
            # No (usable) hierarchy argument: our attribute hierarchies have
            # no deeper level to drill into, so the drill is a no-op.
            return
        child = field_spec(target_ref.parts[0], target_ref.parts[1])
        child.children_of_all = True

        include: list[str] | None = None
        exclude: list[str] = []
        parent: tuple | None = None

        def leaf_values(entries):
            nonlocal parent
            out = []
            for e in entries:
                if not (isinstance(e, MemberRef) and not e.is_measure
                        and len(e.parts) >= 3):
                    continue
                key = (e.parts[0].upper(), e.parts[1].upper())
                if (user_hiers or {}).get(key) is not None:
                    # Drilling a user-hierarchy member: its PATH expands.
                    field_spec(e.parts[0], e.parts[1]).drilled_paths.add(
                        tuple(e.parts[2:])
                    )
                    continue
                if len(e.parts) == 3:
                    parent = key
                    out.append(e.parts[2])
                    walk(e)  # the named member also belongs to the base axis
            return out

        for e in drill:
            if isinstance(e, tuple) and e[0] == "except":
                for inner in e[1]:
                    if (isinstance(inner, MemberRef) and not inner.is_measure
                            and len(inner.parts) >= 3):
                        key = (inner.parts[0].upper(), inner.parts[1].upper())
                        if (user_hiers or {}).get(key) is not None:
                            uspec = field_spec(inner.parts[0], inner.parts[1])
                            path = tuple(inner.parts[2:])
                            uspec.undrilled_paths.add(path)
                            uspec.drilled_depths.add(len(path))
                            continue
                    exclude.extend(leaf_values([inner]))
            elif isinstance(e, MemberRef):
                include = (include or []) + leaf_values([e])
        if parent is not None:
            child.parent_key = parent
            child.parent_exclude = exclude
            child.parent_include = include

    for entry in entries:
        walk(entry)

    specs: list[HierSpec] = []
    if measures:
        specs.append(HierSpec(kind="measures", measures=measures))
    specs.extend(fields.values())
    return specs
