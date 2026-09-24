import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {postgres} from './db.js';
import {bootstrapFirstAdmin} from './admin-bootstrap.js';
// Read credentials through one descriptor: no symlink or stat/read substitution.
const inputPath=process.argv[2];
if(!inputPath||!process.env.DATABASE_URL) throw new Error('Usage: DATABASE_URL from secret environment; bootstrap-cli <owner-only JSON file>');
const db=postgres(process.env.DATABASE_URL);
try {
 const file=await open(inputPath,constants.O_RDONLY|constants.O_NOFOLLOW);
 let input:unknown;
 try {
  const stat=await file.stat();
  if(!stat.isFile()||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.()||stat.size>4096) throw new Error('Invalid secret file permissions');
  input=JSON.parse(await file.readFile('utf8'));
 } finally {await file.close();}
 console.log(JSON.stringify(await bootstrapFirstAdmin(db,input)));
} catch {
 console.error('Bootstrap failed. Check owner-only input permissions, owner database privileges, input policy, migration state, and whether an admin already exists. No credentials were logged.');process.exitCode=1;
} finally {await db.close();}
