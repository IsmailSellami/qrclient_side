// Metadata only. Never selects customer rows, credential values, or function bodies.
import 'dotenv/config';
import pg from 'pg';
import { writeFile, mkdir } from 'node:fs/promises';
import { getPoolOptions } from '../server/database.js';
const verified = process.env.AUDIT_UNVERIFIED_TLS !== '1';
if (!verified) console.error('READ-ONLY AUDIT: using existing unverified TLS configuration; server identity is unverified.');
const connection = getPoolOptions(process.env.DATABASE_URL);
const db = new pg.Client({ ...connection, ssl: { ...connection.ssl, rejectUnauthorized: verified }, connectionTimeoutMillis: 10000 });
try {
  await db.connect();
  await db.query('BEGIN READ ONLY');
  await db.query("SET LOCAL statement_timeout = '10s'");
  const queries = {
    identity: 'SELECT current_user, current_database(), version()',
    roles: "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN (current_user, 'anon', 'authenticated', 'service_role')",
    tables: `SELECT n.nspname AS schema, c.relname AS name, c.relkind, c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls,
      pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('public','storage') AND c.relkind IN ('r','p','v','m') ORDER BY 1,2`,
    columns: "SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns WHERE table_schema IN ('public','storage') ORDER BY 1,2,ordinal_position",
    grants: "SELECT grantee, table_schema, table_name, privilege_type, is_grantable FROM information_schema.role_table_grants WHERE table_schema IN ('public','storage') AND grantee IN ('PUBLIC','anon','authenticated','service_role') ORDER BY 2,3,1,4",
    schemaGrants: `SELECT n.nspname AS schema, CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee, a.privilege_type
      FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
      WHERE n.nspname='public' AND (a.grantee=0 OR a.grantee::regrole::text IN ('anon','authenticated'))`,
    clientRoleMemberships: "SELECT member::regrole::text AS member, roleid::regrole::text AS role FROM pg_auth_members WHERE member IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon','authenticated'))",
    policies: "SELECT schemaname, tablename, policyname, roles, cmd, qual, with_check FROM pg_policies WHERE schemaname IN ('public','storage') ORDER BY 1,2,3",
    functions: `SELECT n.nspname AS schema, p.proname AS name, pg_get_function_identity_arguments(p.oid) AS arguments,
      p.prosecdef AS security_definer, p.proconfig AS settings,
      has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
      has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f' ORDER BY 2`,
    defaults: 'SELECT defaclrole::regrole::text AS owner, defaclnamespace::regnamespace::text AS schema, defaclobjtype AS type, defaclacl::text AS acl FROM pg_default_acl',
    constraints: "SELECT conrelid::regclass::text AS table_name, conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY 1,2",
    sequenceGrants: `SELECT c.relname AS name, CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee, a.privilege_type, a.is_grantable
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('S',c.relowner))) a
      WHERE n.nspname='public' AND c.relkind='S' AND (a.grantee=0 OR a.grantee::regrole::text IN ('anon','authenticated'))`,
    functionGrants: `SELECT p.oid::regprocedure::text AS signature, CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee, a.privilege_type, a.is_grantable
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE n.nspname='public' AND p.prokind='f' AND (a.grantee=0 OR a.grantee::regrole::text IN ('anon','authenticated'))`,
    buckets: 'SELECT id, public, file_size_limit, allowed_mime_types FROM storage.buckets ORDER BY id',
  };
  const report = {};
  for (const [key, query] of Object.entries(queries)) report[key] = (await db.query(query)).rows;
  await db.query('ROLLBACK');
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/database-audit.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ identity: report.identity, roles: report.roles, tables: report.tables, functions: report.functions, buckets: report.buckets, policyCount: report.policies.length, grantCount: report.grants.length }, null, 2));
} catch (error) {
  console.error('Metadata audit failed:', error.code || error.name); // no connection strings
  process.exitCode = 1;
} finally { await db.end(); }
