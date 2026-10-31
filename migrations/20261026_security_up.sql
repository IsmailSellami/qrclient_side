-- REVIEW / STAGING ONLY until shared POS, loyalty app and Worker are checked.
-- Run as the database owner. No customer rows are changed or deleted.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE SCHEMA IF NOT EXISTS app_private;
REVOKE ALL ON SCHEMA app_private FROM PUBLIC, anon, authenticated;
REVOKE CREATE ON SCHEMA public FROM PUBLIC, anon, authenticated;
CREATE TABLE app_private.rate_limits (
  key text PRIMARY KEY, bucket bigint NOT NULL, hits integer NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '2 hours'
);
CREATE INDEX rate_limits_expiry ON app_private.rate_limits(expires_at);
CREATE TABLE app_private.checkout_requests (
  scope text NOT NULL, key text NOT NULL, principal text NOT NULL,
  digest text NOT NULL, response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(scope,key)
);
ALTER TABLE app_private.rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.checkout_requests ENABLE ROW LEVEL SECURITY;

DO $migration$
DECLARE r record;
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='app_server') THEN
    RAISE EXCEPTION 'app_server already exists; review its privileges before applying this migration';
  END IF;
  CREATE ROLE app_server NOLOGIN NOBYPASSRLS NOSUPERUSER;
  -- This frontend never needs direct Data API access. Public menu reads also go
  -- through Express. Preserve service-role/admin grants for separate services.
  FOR r IN SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m')
  LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', r.relname);
    IF r.relkind IN ('r','p') THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',r.relname);
    END IF;
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prokind='f'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated',r.signature);
  END LOOP;
END $migration$;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;
-- These defaults apply to objects created by the migration owner (postgres).
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;
-- Schema-specific REVOKE cannot cancel PostgreSQL's global PUBLIC EXECUTE default.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

GRANT USAGE ON SCHEMA public, app_private TO app_server;
GRANT SELECT, INSERT, UPDATE ON app_private.rate_limits TO app_server;
GRANT SELECT, INSERT ON app_private.checkout_requests TO app_server;
CREATE POLICY backend_rate_limits ON app_private.rate_limits TO app_server USING (true) WITH CHECK (true);
CREATE POLICY backend_checkout_requests ON app_private.checkout_requests TO app_server USING (true) WITH CHECK (true);
GRANT SELECT ON categorie, product, promotion, qr_code, recu, orderr,
  loyalty_recharge_packages, loyalty_rewards, loyalty_challenges,
  customer_rewards, customer_challenges, customer_visits, point_today, system_state TO app_server;
GRANT INSERT ON recu, orderr, customer_rewards, customer_visits, system_state, notifications TO app_server;
GRANT UPDATE ON recu, qr_code, customer_rewards, customer_visits, system_state TO app_server;
GRANT DELETE ON customer_visits TO app_server;
-- Needed for INSERT .. ON CONFLICT / RETURNING in notification queries.
GRANT SELECT ON notifications TO app_server;
DO $sequences$
DECLARE r record;
BEGIN
  FOR r IN SELECT DISTINCT n.nspname, s.relname FROM pg_class s
    JOIN pg_namespace n ON n.oid=s.relnamespace
    JOIN pg_depend d ON d.objid=s.oid AND d.classid='pg_class'::regclass
    JOIN pg_class t ON t.oid=d.refobjid
    WHERE s.relkind='S' AND n.nspname='public'
      AND t.relname IN ('recu','orderr','customer_rewards','customer_visits','notifications')
      AND d.deptype IN ('a','i')
  LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %I.%I TO app_server',r.nspname,r.relname);
  END LOOP;
END $sequences$;
DO $policies$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['categorie','product','promotion','qr_code','recu','orderr',
    'loyalty_recharge_packages','loyalty_rewards','loyalty_challenges','customer_rewards',
    'customer_challenges','customer_visits','point_today','system_state','notifications']
  LOOP
    EXECUTE format('CREATE POLICY backend_access ON public.%I TO app_server USING (true) WITH CHECK (true)',t);
  END LOOP;
END $policies$;
COMMIT;
