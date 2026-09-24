import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import type {Database} from './db.js';
export async function migrate(db:Database) {
 await db.transaction(async tx=>{
  await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  await tx.query('LOCK TABLE schema_migrations IN EXCLUSIVE MODE');
  for(const name of (await readdir('db/migrations')).filter(n=>n.endsWith('.sql')).sort()) {
   const sql=await readFile(`db/migrations/${name}`,'utf8'); const checksum=createHash('sha256').update(sql).digest('hex');
   const previous=(await tx.query('SELECT checksum FROM schema_migrations WHERE name=$1',[name])).rows[0];
   if(previous) {if(previous.checksum!==checksum) throw new Error(`Migration changed: ${name}`); continue;}
   await tx.query(sql); await tx.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',[name,checksum]);
  }
 });
}
