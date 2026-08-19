"""How a member is rendered for the wire: unique names and DisplayInfo.

DisplayInfo is how the server TELLS Excel each member's drill state
(0x10000 = drilled down, low bits = an estimated child count); Excel
rebuilds its own collapse bookkeeping from it after every response.
Without the flag a collapse is forgotten by the very next gesture
(observed live: collapsing O silently re-expanded F). Every member
carries PARENT_UNIQUE_NAME and HIERARCHY_UNIQUE_NAME because the
mddataset declares those properties in HierarchyInfo -- an undeclared
property is a schema violation ADOMD rejects outright.
"""

from app.xmla.discover import path_unique_name
from app.xmla.mdx import HierSpec

#: All-member DisplayInfo: DRILLED_DOWN flag plus the child count.
_DRILLED = 0x10000


class MemberBuilders:
    """Member construction, mixed into the engine.

    Relies on the engine's `_run` (cached grouping queries) and
    `_surrogate` (per-level stand-in specs) for user-hierarchy values.
    """

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

    def _userhier_members(self, spec: HierSpec) -> list:
        """(member, assignment) pairs for a user hierarchy on an axis, in
        Hierarchize order: each shown path, parents before children, with
        children under every drilled path. Values come from prefix-scoped
        DISTINCT group-bys, one per depth, cached like every grouping."""
        levels = spec.levels
        hu = self._hier_uname(spec)

        def drilled(path: tuple) -> bool:
            if path in spec.undrilled_paths:
                return False
            return path in spec.drilled_paths or len(path) in spec.drilled_depths

        def member(path: tuple) -> dict:
            depth = len(path)
            caption = "" if path[-1] is None else str(path[-1])
            info = 0
            if depth < len(levels):
                info = (_DRILLED if drilled(path) else 0) | 1000
            return {
                "hierarchy": hu,
                "uname": path_unique_name(spec.table, spec.hier_field, path),
                "caption": caption,
                "lname": f"{hu}.[{levels[depth - 1][1]}]",
                "lnum": depth,
                "display_info": info,
                "properties": {
                    "PARENT_UNIQUE_NAME": (
                        path_unique_name(spec.table, spec.hier_field, path[:-1])
                        if depth > 1 else f"{hu}.[All]"
                    ),
                    "HIERARCHY_UNIQUE_NAME": hu,
                },
            }

        def assignment(path: tuple) -> dict:
            return {
                (levels[i][0].upper(), levels[i][1].upper()): path[i]
                for i in range(len(path))
            }

        def children(prefix: tuple) -> list:
            depth = len(prefix) + 1
            if depth > len(levels):
                return []
            table = self._run([self._surrogate(t, n) for t, n in levels[:depth]])
            return [k for k in table if k[: len(prefix)] == prefix]

        out: list = []
        emitted: set = set()

        def emit(path: tuple) -> None:
            if path in emitted:
                return
            emitted.add(path)
            out.append((member(path), assignment(path)))

        def walk(prefix: tuple) -> None:
            for key in children(prefix):
                emit(key)
                if drilled(key):
                    walk(key)

        if spec.include_all:
            info = (_DRILLED if drilled(()) else 0) | 1000
            out.append((
                {
                    "hierarchy": hu,
                    "uname": f"{hu}.[All]",
                    "caption": "All",
                    "lname": f"{hu}.[(All)]",
                    "lnum": 0,
                    "display_info": info,
                },
                None,
            ))
        for depth in sorted(spec.flat_depths):
            if 1 <= depth <= len(levels):
                table = self._run(
                    [self._surrogate(t, n) for t, n in levels[:depth]]
                )
                for key in table:
                    emit(key)
        if drilled(()):
            walk(())
        for path in spec.member_paths:
            emit(path)
            if drilled(path):
                walk(path)
        # A drilled path whose own member is not shown (the dropdown asks
        # for [H].&[EUROPE].Children alone) still answers its children.
        for path in sorted(spec.drilled_paths, key=len):
            if path and path not in emitted:
                walk(path)
        return out

    def _measure_member(self, name: str) -> dict:
        return {
            "hierarchy": "[Measures]",
            "uname": f"[Measures].[{name}]",
            "caption": name.split(".", 1)[-1],
            "lname": "[Measures].[MeasuresLevel]",
            "lnum": 0,
            "display_info": 0,
        }
