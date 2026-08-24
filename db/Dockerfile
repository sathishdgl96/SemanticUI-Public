# A Postgres image for SemanticUI, separate from the app image. The
# NON-secret choices (user, database name) are baked in so every
# environment agrees on them; the password deliberately is not -- an ENV
# here would sit in the image for anyone with `docker history` to read.
# Pass it at run time:  -e POSTGRES_PASSWORD=...
#
# These take effect only on the FIRST boot with an empty data volume;
# after that, the credentials live in the volume, not the image.
FROM postgres:16-alpine

ENV POSTGRES_USER=semanticui \
    POSTGRES_DB=semanticui

HEALTHCHECK --interval=5s --timeout=3s --retries=10 \
    CMD pg_isready -U "$POSTGRES_USER" || exit 1

# First-boot SQL or shell scripts (extensions, extra roles) go in
# db/init/ and run once, alphabetically, on an empty volume:
# COPY init/ /docker-entrypoint-initdb.d/
