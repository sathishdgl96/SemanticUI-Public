"""A sliding-window rate limiter for the auth surfaces.

In-process on purpose: auth attempts are the one thing that must be
throttled even when the database is the thing under attack. Keys combine
client address and the claimed identity so an attacker cannot lock out a
user from afar without also revealing an address to block, and a shared
NAT does not lock out a whole office for one person's typos.

The interface is deliberately tiny (allow / register_failure) so a
Redis-backed implementation can replace it for multi-replica deployments
without touching call sites.
"""

import threading
import time
from collections import deque

#: Attempts allowed per window before 429s begin.
LIMIT = 8
WINDOW_SECONDS = 60.0


class SlidingWindow:
    def __init__(self, limit: int = LIMIT, window: float = WINDOW_SECONDS,
                 clock=time.monotonic) -> None:
        self._limit = limit
        self._window = window
        self._clock = clock
        self._hits: dict[str, deque] = {}
        self._lock = threading.Lock()

    def _prune(self, key: str, now: float) -> deque:
        hits = self._hits.setdefault(key, deque())
        while hits and now - hits[0] > self._window:
            hits.popleft()
        if not hits:
            # Empty deques are dropped so the dict cannot grow without
            # bound under a scan of many identities.
            self._hits.pop(key, None)
            hits = self._hits.setdefault(key, deque())
        return hits

    def allowed(self, key: str) -> bool:
        """True while the key has failure budget left in the window."""
        with self._lock:
            now = self._clock()
            return len(self._prune(key, now)) < self._limit

    def register_failure(self, key: str) -> None:
        with self._lock:
            now = self._clock()
            self._prune(key, now).append(now)

    def retry_after(self, key: str) -> int:
        with self._lock:
            now = self._clock()
            hits = self._prune(key, now)
            if len(hits) < self._limit:
                return 0
            return max(1, int(self._window - (now - hits[0])) + 1)


_auth_window: SlidingWindow | None = None


def auth_window() -> SlidingWindow:
    global _auth_window
    if _auth_window is None:
        _auth_window = SlidingWindow()
    return _auth_window
