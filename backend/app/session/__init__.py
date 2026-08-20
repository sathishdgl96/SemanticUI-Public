"""The execution context a session runs as: role and warehouse.

Distinct from `app.auth`, which settles WHO the caller is. This package
settles what they are currently acting AS -- a thing they may change
mid-session without signing in again.
"""
