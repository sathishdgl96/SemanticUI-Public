# Multi-stage: build the SPA, install the backend from its lockfile, run
# both as one non-root process -- the backend serves the built frontend.

FROM node:22-slim AS spa
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim AS runtime
WORKDIR /app

# curl only, for the container healthcheck.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# --chmod everywhere: COPY preserves the build machine's file modes, and
# a root-owned or 600 checkout otherwise yields files appuser cannot read
# -- alembic reads pyproject.toml at startup and dies on exactly that.
COPY --chmod=644 backend/requirements.lock backend/pyproject.toml ./
RUN pip install --no-cache-dir -r requirements.lock

COPY --chmod=755 backend/app ./app
COPY --chmod=755 backend/migrations ./migrations
COPY --chmod=644 backend/alembic.ini ./alembic.ini
COPY --from=spa --chmod=755 /build/dist ./static

ENV SEMANTICUI_STATIC_DIR=/app/static \
    PYTHONUNBUFFERED=1

RUN useradd --create-home appuser
USER appuser

EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s \
    CMD curl -fsS http://localhost:8000/healthz || exit 1

# Migrations run on start: an image that boots IS at schema head. A
# multi-replica rollout serialises on Postgres' own locks.
CMD ["sh", "-c", "python -m alembic upgrade head && python -m uvicorn app.main:app --host 0.0.0.0 --port 8000"]
