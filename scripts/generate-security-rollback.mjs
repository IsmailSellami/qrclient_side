// Generate from a fresh read-only metadata snapshot before applying the up file.
// Never reads customer rows. Output contains permission metadata only.
import { readFile, writeFile } from 'node:fs/promises';
const audit = JSON.parse(await readFile(process.argv[2] || 'artifacts/database-audit.json','utf8'));
const quote = name => '"'+name.replaceAll('"','""')+'"';
const role = name => name === 'PUBLIC' ? 'PUBLIC' : quote(name);
const sql = ['-- Restores the inspected pre-hardening permissions, INCLUDING unsafe client access.',
  '-- Emergency rollback only. Re-snapshot if metadata changes before deployment.',
  '-- Keep checkout_requests: deleting payment idempotency records permits replays.',
  'BEGIN;', "SET LOCAL lock_timeout = '5s';"];
for(const t of audit.tables.filter(t=>t.schema==='public')) {
  const name='public.'+quote(t.name);
  sql.push(`REVOKE ALL ON ${name} FROM PUBLIC, anon, authenticated;`);
  if(['r','p'].includes(t.relkind)) sql.push(`DROP POLICY IF EXISTS backend_access ON ${name};`,
    `ALTER TABLE ${name} ${t.rls?'ENABLE':'DISABLE'} ROW LEVEL SECURITY;`);
}
for(const g of audit.grants.filter(g=>g.table_schema==='public')) sql.push(`GRANT ${g.privilege_type} ON public.${quote(g.table_name)} TO ${role(g.grantee)}${g.is_grantable==='YES'?' WITH GRANT OPTION':''};`);
for(const g of audit.schemaGrants.filter(g=>g.privilege_type==='CREATE')) sql.push(`GRANT CREATE ON SCHEMA public TO ${role(g.grantee)};`);
for(const f of audit.functions) {
  const signature=`public.${quote(f.name)}(${f.arguments})`;
  sql.push(`REVOKE EXECUTE ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated;`);
}
for(const g of audit.functionGrants) sql.push(`GRANT ${g.privilege_type} ON FUNCTION ${g.signature} TO ${role(g.grantee)}${g.is_grantable?' WITH GRANT OPTION':''};`);
sql.push('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;');
for(const g of audit.sequenceGrants) sql.push(`GRANT ${g.privilege_type} ON SEQUENCE public.${quote(g.name)} TO ${role(g.grantee)}${g.is_grantable?' WITH GRANT OPTION':''};`);
// Up modifies defaults only for its executing role. Original snapshot was postgres.
for(const [kind,object] of [['r','TABLES'],['S','SEQUENCES'],['f','FUNCTIONS']]) {
  sql.push(`ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON ${object} FROM PUBLIC, anon, authenticated;`);
  const original=audit.defaults.find(d=>d.owner==='postgres' && d.schema==='public' && d.type===kind);
  if(original) {
    const codes=kind==='f'?{X:'EXECUTE'}:kind==='S'?{r:'SELECT',w:'UPDATE',U:'USAGE'}:{a:'INSERT',r:'SELECT',w:'UPDATE',d:'DELETE',D:'TRUNCATE',x:'REFERENCES',t:'TRIGGER',m:'MAINTAIN'};
    for(const match of original.acl.matchAll(/(?:\{|,)([^=]+)=([^/]*)\//g)) {
      const grantee=match[1] || 'PUBLIC';
      if(!['PUBLIC','anon','authenticated'].includes(grantee))continue;
      const privileges=[...match[2]].filter(c=>codes[c]).map(c=>codes[c]);
      if(privileges.length)sql.push(`ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ${privileges.join(',')} ON ${object} TO ${role(grantee)};`);
    }
  }
}
// PostgreSQL's original global function default (no global override in snapshot).
if(audit.defaults.some(d=>d.owner==='postgres' && d.type==='f' && ['-','0',''].includes(d.schema))) throw new Error('Review custom global function defaults manually');
sql.push('ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT EXECUTE ON FUNCTIONS TO PUBLIC;',
  '-- app_private and app_server are retained to preserve replay records and permit roll-forward.', 'COMMIT;');
await writeFile('migrations/20261026_security_down.sql',sql.join('\n')+'\n');
console.log('Wrote snapshot-specific rollback; no database changes made.');
