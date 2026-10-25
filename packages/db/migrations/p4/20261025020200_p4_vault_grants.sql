-- P1 creates the actual roles. No login/role provisioning by P4.
-- Role names default to P1's campus_app / campus_gateway (override: SET p4.app_role / p4.gateway_role).
-- Missing/unsafe roles FAIL migration; no permissive fallback.
DO $$
-- Defaults: the roles P1 creates (20261024000100_roles_grants.sql); override with SET p4.*_role.
DECLARE app_role text := coalesce(nullif(current_setting('p4.app_role', true), ''), 'campus_app');
        gateway_role text := coalesce(nullif(current_setting('p4.gateway_role', true), ''), 'campus_gateway');
        role_name text;
BEGIN
  IF app_role IS NULL OR gateway_role IS NULL OR app_role = gateway_role THEN
    RAISE EXCEPTION 'Configure distinct p4.app_role and p4.gateway_role';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=app_role AND NOT rolsuper AND NOT rolbypassrls)
    OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=gateway_role AND NOT rolsuper AND NOT rolbypassrls) THEN
    RAISE EXCEPTION 'P1 must provision non-superuser, non-BYPASSRLS app/gateway roles first';
  END IF;
  -- Remove all explicit non-owner grants; inherited access is checked below.
  REVOKE ALL ON SCHEMA vault FROM PUBLIC;
  REVOKE ALL ON ALL TABLES IN SCHEMA vault FROM PUBLIC;
  FOR role_name IN SELECT DISTINCT grantee FROM information_schema.role_table_grants
    WHERE table_schema='vault' AND grantee NOT IN (gateway_role,current_user,'PUBLIC') LOOP
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA vault FROM %I',role_name);
    EXECUTE format('REVOKE ALL ON SCHEMA vault FROM %I',role_name);
  END LOOP;
  EXECUTE format('REVOKE ALL ON SCHEMA vault FROM %I',app_role);
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA vault FROM %I',app_role);
  EXECUTE format('GRANT USAGE ON SCHEMA vault TO %I',gateway_role);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA vault TO %I',gateway_role);
  EXECUTE format('GRANT USAGE ON SCHEMA mcp TO %I',gateway_role);
  EXECUTE format('GRANT SELECT ON mcp.user_connections TO %I',gateway_role);
  -- Prevent the general role from SET ROLE into the gateway role (also via inheritance).
  IF pg_has_role(app_role,gateway_role,'MEMBER') OR has_table_privilege(app_role,'vault.credentials','SELECT') THEN
    RAISE EXCEPTION 'Unsafe inherited vault privileges; P1 must separate role membership/ownership';
  END IF;
  ALTER DEFAULT PRIVILEGES IN SCHEMA vault REVOKE ALL ON TABLES FROM PUBLIC;
END $$;
