#!/usr/bin/env bash
# Creates the NOLOGIN group roles (also created idempotently by the roles migration) and two LOGIN users:
#   campus_app_user     → member of campus_app      (DATABASE_URL; cannot read vault.*)
#   campus_gateway_user → member of campus_gateway  (DATABASE_URL_VAULT; tool gateway only)
# Passwords come from the container environment (your local .env), never from the repo.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_pw="$APP_DB_PASSWORD" -v gw_pw="$GATEWAY_DB_PASSWORD" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campus_app') THEN CREATE ROLE campus_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campus_gateway') THEN CREATE ROLE campus_gateway NOLOGIN; END IF;
END
$$;
SELECT format('CREATE ROLE campus_app_user LOGIN PASSWORD %L IN ROLE campus_app', :'app_pw')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campus_app_user') \gexec
SELECT format('CREATE ROLE campus_gateway_user LOGIN PASSWORD %L IN ROLE campus_gateway', :'gw_pw')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campus_gateway_user') \gexec
SQL
