import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const files=[...new Set(execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean))];
const patterns=[
 ['private-key',/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
 ['telegram-token',/\b\d{6,12}:[A-Za-z0-9_-]{30,50}\b/],
 ['github-token',/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
 ['cloud-access-key',/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
 ['api-key',/\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/],
];
let findings=0;
for(const path of files) {
 if(/(?:^|\/)\.env(?:\..*)?$/.test(path)&&path!=='.env.example'||/\.(?:pem|p12|pfx|key)$/.test(path)||/(?:^|\/)(?:id_rsa|id_ed25519|credentials\.json)$/.test(path)) {
  console.error(`${path}: forbidden credential file`);findings++;continue;
 }
 const text=readFileSync(path,'utf8');
 for(const [i,line] of text.split('\n').entries()) {
  for(const [kind,re] of patterns) if(re.test(line)) {console.error(`${path}:${i+1}: ${kind} (value redacted)`);findings++;}
  for(const match of line.matchAll(/postgres(?:ql)?:\/\/[^\s"'`]+/g)) {
   const value=match[0];
   if(!value.includes('@')) continue;
   if(/^postgresql:\/\/telegram_app:CHANGE_ME@127\.0\.0\.1:5432\/telegram_ops$/.test(value)) continue;
   if(/^postgresql:\/\/postgres:postgres@(?:localhost|127\.0\.0\.1):5432\/telegram_test$/.test(value)) continue;
   console.error(`${path}:${i+1}: unexpected database credential URL (value redacted)`);findings++;
  }
 }
}
console.log(`Secret scan: ${files.length} candidate files, ${findings} findings. CI-only localhost credentials and documented placeholders allowed.`);
if(findings) process.exit(1);
