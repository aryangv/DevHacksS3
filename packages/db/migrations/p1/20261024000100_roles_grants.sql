-- DB roles and grants (spec 6.4, 8): the application's general role cannot read vault.*;
-- only the tool-gateway role can. Group roles are NOLOGIN; login users are granted membership
-- outside the repo (no passwords in migrations). See docker/postgres/init-roles.sh for local dev.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campus_app') THEN
    CREATE ROLE campus_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campus_gateway') THEN
    CREATE ROLE campus_gateway NOLOGIN;
  END IF;
END
$$;

-- core + mcp: both roles read/write (row-level checks happen in code; RLS is optional defense in depth).
GRANT USAGE ON SCHEMA core, mcp TO campus_app, campus_gateway;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core, mcp TO campus_app, campus_gateway;
ALTER DEFAULT PRIVILEGES IN SCHEMA core, mcp GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO campus_app, campus_gateway;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA core, mcp TO campus_app, campus_gateway;
ALTER DEFAULT PRIVILEGES IN SCHEMA core, mcp GRANT USAGE, SELECT ON SEQUENCES TO campus_app, campus_gateway;

-- vault: gateway role only. DELETE is included for disconnect/revoke (spec 6.3 step 5).
REVOKE ALL ON SCHEMA vault FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA vault FROM PUBLIC;
REVOKE ALL ON SCHEMA vault FROM campus_app;
REVOKE ALL ON ALL TABLES IN SCHEMA vault FROM campus_app;
GRANT USAGE ON SCHEMA vault TO campus_gateway;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA vault TO campus_gateway;
ALTER DEFAULT PRIVILEGES IN SCHEMA vault GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO campus_gateway;
