import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import dotenv from 'dotenv';
// Print locations and credential classes ONLY, never matched text or values.
const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const env = existsSync('.env') ? dotenv.parse(readFileSync('.env')) : {};
const secretValues = Object.entries(env).filter(([key,value]) => /PASSWORD|SECRET|DATABASE_URL|KEY|TOKEN/i.test(key) && value.length > 15 && !value.startsWith('sb_publishable_'));
const patterns = [
  ['database-url', /postgres(?:ql)?:\/\/[^\s'"<>]+:[^\s'"<>]+@/g],
  ['supabase-secret', /sb_secret_[A-Za-z0-9_-]{15,}/g],
  ['jwt', /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{12,}/g],
  ['provider-token', /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/g],
];
const hits = [];
function scan(source, content) {
  const lines = content.split('\n');
  lines.forEach((line, index) => {
    for (const [kind,pattern] of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(line) && !/postgres(?:ql)?:\/\/(?:user:password|app.project:p%40ss)/.test(line)) hits.push({ source, line: index + 1, kind });
    }
    for (const [key,value] of secretValues) if (line.includes(value)) hits.push({ source, line: index + 1, kind: 'exact-local-' + key });
  });
}
const objects = git(['rev-list','--objects','--all']).trim().split('\n');
let blobs = 0;
for (const object of objects) {
  const [sha,...parts] = object.split(' ');
  if (git(['cat-file','-t',sha]).trim() !== 'blob') continue;
  const content = git(['cat-file','blob',sha]);
  if (content.includes('\0')) continue;
  blobs++;
  scan('git:' + sha + ':' + parts.join(' '), content);
}
let files = 0;
function walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (['node_modules','.git','security-tools','npm-cache','browsers'].includes(entry)) continue;
    if (entry === 'browser-test-key.pem') continue; // disposable, ignored TLS fixture; never shipped
    const path = dir + '/' + entry;
    if (statSync(path).isDirectory()) walk(path);
    else if (statSync(path).size < 10_000_000 && !/\.(png|jpg|jpeg|webp|ico)$/i.test(path)) {
      files++;
      const content = readFileSync(path,'utf8');
      if (!content.includes('\0')) scan(path,content);
    }
  }
}
for (const path of git(['ls-files','-co','--exclude-standard','-z']).split('\0').filter(Boolean)) {
  if (!existsSync(path) || statSync(path).size > 10_000_000) continue;
  const content = readFileSync(path,'utf8');
  if (!content.includes('\0')) { files++;scan('worktree:'+path,content); }
}
for (const dir of ['artifacts','.vercel']) walk(dir);
mkdirSync('artifacts',{ recursive:true });
const report = { commits: git(['rev-list','--all','--count']).trim(), blobs, files, hits };
writeFileSync('artifacts/secret-audit.json', JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
