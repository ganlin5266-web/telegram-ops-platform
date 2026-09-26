import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrations.js';
import {seedStaging,seedMode,seedBot} from '../src/staging-seed.js';
import {seedStagingUsers,syntheticUsers} from '../src/staging-users-seed.js';
import type {Database,Queryable} from '../src/db.js';
const good={database:'telegram_ops_staging',ssl:true,is_owner:true,table_owner:true,runtime:false};
type Hooks={identity?:Record<string,unknown>;fail?:string;events?:string[];beforeLock?:()=>Promise<void>};
function wrap(db:Database,h:Hooks={}):Database {
 return {...db,transaction:fn=>db.transaction(tx=>fn({query:async(sql,params)=>{
  h.events?.push(sql);
  // Only the TEST adapter substitutes external identity/TLS metadata. No runtime bypass exists.
  if(sql.startsWith('SELECT current_database()')) return {rows:[h.identity??good]} as any;
  if(sql.includes('pg_advisory_xact_lock')) {await h.beforeLock?.();if(!process.env.TEST_DATABASE_URL)return {rows:[]} as any;}
  if(h.fail && sql.includes(h.fail)) throw Error('synthetic failure');
  return tx.query(sql,params);
 }}))};
}
async function fixture(fn:(db:Database,raw:Database)=>Promise<void>) {
 let raw:Database,close:()=>Promise<void>;
 if(process.env.TEST_DATABASE_URL) {
  const root=new pg.Client({connectionString:process.env.TEST_DATABASE_URL});await root.connect();
  const name='users_seed_'+randomUUID().replaceAll('-','');
  await root.query(`CREATE DATABASE "${name}"`);
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;
  const pool=new pg.Pool({connectionString:url.href,max:5});
  raw={query:(s,p)=>pool.query(s,p),transaction:async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const v=await fn(c);await c.query('COMMIT');return v;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};
  close=async()=>{await pool.end();await root.query(`DROP DATABASE "${name}"`);await root.end();};
 } else {
  const memory=new PGlite();
  const adapt=(c:any):Queryable=>({query:async(s,p)=>p===undefined?(await c.exec(s)).at(-1)??{rows:[]}:c.query(s,p)});
  raw={...adapt(memory),transaction:fn=>memory.transaction(tx=>fn(adapt(tx)))};
  close=()=>memory.close();
 }
 try {
  await migrate(raw);
  await raw.query("INSERT INTO admins(auth_subject,display_name) VALUES('local:staging-admin','test')");
  await raw.query("INSERT INTO admin_credentials(admin_id,login,password_hash) SELECT id,'staging-admin','synthetic-unused-fixture' FROM admins");
  await raw.query("INSERT INTO admin_roles(admin_id,role_id) SELECT a.id,r.id FROM admins a CROSS JOIN roles r WHERE r.name='Super Admin'");
  await seedStaging(wrap(raw),true);
  await fn(wrap(raw),raw);
 }finally{await close();}
}
async function counts(raw:Queryable) {
 return (await raw.query(`SELECT (SELECT count(*)::int FROM telegram_users) users,
 (SELECT count(*)::int FROM point_accounts) accounts,(SELECT count(*)::int FROM point_ledger) ledger,
 (SELECT count(*)::int FROM referrals) referrals,(SELECT count(*)::int FROM audit_logs WHERE action='staging-users-v1.create') audits`)).rows[0];
}
const empty={users:0,accounts:0,ledger:0,referrals:0,audits:0};
const full={users:3,accounts:2,ledger:3,referrals:1,audits:8};
test('users seed defaults to dry-run, explicit apply only',()=>{
 assert.equal(seedMode([]),false);assert.equal(seedMode(['--dry-run']),false);assert.equal(seedMode(['--apply']),true);assert.throws(()=>seedMode(['--force']));
});
test('users dry-run performs no writes or audit',()=>fixture(async(_,raw)=>{
 const events:string[]=[];const result=await seedStagingUsers(wrap(raw,{events}));
 assert.equal(result.mode,'dry-run');assert.equal(result.createdObjects,8);assert.deepEqual(await counts(raw),empty);
 assert.equal(events[0],'SET TRANSACTION READ ONLY');assert.ok(!events.some(s=>/^INSERT|^UPDATE|^DELETE/.test(s)));
}));
test('users apply creates exact profiles, ledger, referral; repeat and dry-run add zero',()=>fixture(async(db,raw)=>{
 const fetchBefore=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('network forbidden');};
 try {
 assert.equal((await seedStagingUsers(db,true)).createdObjects,8);
 assert.equal((await seedStagingUsers(db,true)).createdObjects,0);
 assert.equal((await seedStagingUsers(db)).createdObjects,0);
 assert.deepEqual(await counts(raw),full);assert.equal(calls,0);
 const users=(await raw.query('SELECT *,telegram_user_id::text AS telegram_user_id FROM telegram_users ORDER BY telegram_users.telegram_user_id')).rows;
 for(const [i,u] of users.entries())for(const [key,value] of Object.entries(syntheticUsers[i]!))assert.deepEqual(u[key],value);
 const balances=(await raw.query(`SELECT a.user_id,a.balance::text, SUM(l.delta)::text AS total FROM point_accounts a JOIN point_ledger l ON l.account_id=a.id GROUP BY a.id ORDER BY a.user_id`)).rows;
 assert.deepEqual(balances.map(r=>[r.balance,r.total]),[['1000','1000'],['380','380']]);
 assert.equal((await raw.query('SELECT count(*)::int AS n FROM point_accounts WHERE user_id=$1',[syntheticUsers[2]!.id])).rows[0]!.n,0);
 assert.equal((await raw.query("SELECT COALESCE((SELECT balance::text FROM point_accounts WHERE user_id=$1),'0') AS balance",[syntheticUsers[2]!.id])).rows[0]!.balance,'0');
 const ref=(await raw.query('SELECT * FROM referrals')).rows[0]!;
 assert.equal(ref.inviter_id,syntheticUsers[0]!.id);assert.equal(ref.invitee_id,syntheticUsers[1]!.id);assert.notEqual(ref.inviter_id,ref.invitee_id);
 assert.equal(ref.start_parameter,'ref_staging_users_v1_a');assert.equal(ref.status,'bound');assert.equal(ref.reward_status,'pending');
 assert.equal((await raw.query('SELECT status FROM telegram_bots')).rows[0]!.status,'disabled');
 for(const table of ['telegram_updates','redemptions','activities','message_delivery_logs'])assert.equal((await raw.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n,0);
 }finally{globalThis.fetch=fetchBefore;}
}));
for(const [name,patch,code] of [
 ['database',{database:'production'},'not_staging_database'],['owner',{is_owner:false},'maintenance_owner_required'],
 ['runtime',{runtime:true},'maintenance_owner_required'],['table owner',{table_owner:false},'maintenance_owner_required'],['SSL',{ssl:false},'tls_required'],
] as const)test(`users reject invalid ${name}`,()=>fixture(async(_,raw)=>{
 await assert.rejects(()=>seedStagingUsers(wrap(raw,{identity:{...good,...patch}}),true),new RegExp(code));assert.deepEqual(await counts(raw),empty);
}));
for(const [name,sql,code] of [
 ['migration set',"DELETE FROM schema_migrations WHERE name='006_dashboard.sql'",'migration_set_mismatch'],
 ['migration checksum',"UPDATE schema_migrations SET checksum='bad' WHERE name='006_dashboard.sql'",'migration_checksum_mismatch'],
 ['Brand',"UPDATE brands SET timezone='Asia/Shanghai'",'brand_conflict'],
 ['Bot',"UPDATE telegram_bots SET name='wrong'",'bot_conflict'],
 ['active Bot',"UPDATE telegram_bots SET status='active'",'bot_conflict'],
 ['inactive admin',"UPDATE admins SET status='disabled'",'active_global_staging_admin_required'],
 ['missing credential',"DELETE FROM admin_credentials",'active_global_staging_admin_required'],
 ['scoped admin',"UPDATE admin_roles SET brand_id=(SELECT id FROM brands)",'active_global_staging_admin_required'],
 ['missing permission',"DELETE FROM role_permissions WHERE role_id=(SELECT id FROM roles WHERE name='Super Admin')",'active_global_staging_admin_required'],
] as const)test(`users reject ${name}`,()=>fixture(async(db,raw)=>{
 await raw.query(sql);await assert.rejects(()=>seedStagingUsers(db,true),new RegExp(code));assert.deepEqual(await counts(raw),empty);
}));
for(const key of [seedBot.token_secret_ref,seedBot.webhook_secret_ref])test(`users reject configured ref ${key}`,()=>fixture(async(db,raw)=>{
 const before=process.env[key];process.env[key]='';try{await assert.rejects(()=>seedStagingUsers(db,true),/test_secret_reference/);}finally{if(before===undefined)delete process.env[key];else process.env[key]=before;}assert.deepEqual(await counts(raw),empty);
}));
test('users conflict rolls back earlier new users and audit',()=>fixture(async(db,raw)=>{
 const u=syntheticUsers[1]!;
 await raw.query(`INSERT INTO telegram_users(id,brand_id,bot_id,telegram_user_id,username) SELECT $1,brand_id,id,$2,'conflict' FROM telegram_bots`,[u.id,u.telegram_user_id]);
 await assert.rejects(()=>seedStagingUsers(db,true),/user_conflict/);assert.deepEqual(await counts(raw),{...empty,users:1});
}));
test('users refuse changed profile without repair',()=>fixture(async(db,raw)=>{
 await seedStagingUsers(db,true);await raw.query("UPDATE telegram_users SET preferred_language='en' WHERE id=$1",[syntheticUsers[0]!.id]);
 await assert.rejects(()=>seedStagingUsers(db,true),/user_conflict/);assert.deepEqual(await counts(raw),full);
}));
test('users refuse changed referral without overwriting',()=>fixture(async(db,raw)=>{
 await seedStagingUsers(db,true);await raw.query("UPDATE referrals SET status='invalid'");
 await assert.rejects(()=>seedStagingUsers(db,true),/referral_conflict/);assert.deepEqual(await counts(raw),full);
}));
for(const fail of ['INSERT INTO point_ledger','INSERT INTO referrals',"INSERT INTO audit_logs"])test(`users rollback on ${fail} failure`,()=>fixture(async(_,raw)=>{
 await assert.rejects(()=>seedStagingUsers(wrap(raw,{fail}),true),/synthetic failure/);assert.deepEqual(await counts(raw),empty);
}));
test('users refuse unrelated points rather than restoring initial balance',()=>fixture(async(db,raw)=>{
 await seedStagingUsers(db,true);
 const {postPoints}=await import('../src/points.js');const b=(await raw.query('SELECT * FROM telegram_bots')).rows[0]!;
 await raw.transaction(tx=>postPoints(tx,{brandId:b.brand_id,botId:b.id,userId:syntheticUsers[0]!.id,delta:'1',source:'test',businessType:'test',businessId:'extra',idempotencyKey:'extra'}));
 await assert.rejects(()=>seedStagingUsers(db,true),/points_conflict/);assert.equal((await counts(raw))!.ledger,4);
}));
test('users CLI retains strict TLS normalization and has no webhook/network entrypoint',()=>{
 const cli=readFileSync('src/staging-users-seed-cli.ts','utf8');assert.match(cli,/sslmode','verify-full/);assert.match(cli,/NODE_TLS_REJECT_UNAUTHORIZED/);assert.doesNotMatch(cli,/rejectUnauthorized\s*:\s*false/);
 const source=readFileSync('src/staging-users-seed.ts','utf8');assert.doesNotMatch(source,/handleUpdate|fetch\(|api\.telegram|INSERT INTO point_ledger|UPDATE point_accounts/);assert.match(source,/await postPoints\(/);
});
test('users real PostgreSQL concurrent apply is serialized and idempotent',{skip:!process.env.TEST_DATABASE_URL,timeout:30000},()=>fixture(async(_,raw)=>{
 let arrivals=0,release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const pids=new Set<number>();const events:string[]=[];
 const db:Database={...raw,transaction:fn=>raw.transaction(async tx=>{
  pids.add((await tx.query('SELECT pg_backend_pid() pid')).rows[0]!.pid);
  if(++arrivals===2)release();await gate;return fn(tx);
 })};
 const results=await Promise.all([seedStagingUsers(wrap(db,{events}),true),seedStagingUsers(wrap(db,{events}),true)]);
 assert.equal(pids.size,2);assert.deepEqual(results.map(r=>r.createdObjects).sort((a,b)=>a-b),[0,8]);assert.deepEqual(await counts(raw),full);
 assert.equal(events.filter(s=>s.includes('pg_advisory_xact_lock')).length,2);
}));
