import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {migrate} from '../src/migrations.js';
import {seedStaging,seedMode,seedBrand,seedBot,checkIdentity} from '../src/staging-seed.js';
import type {Database,Queryable} from '../src/db.js';
const good={database:'telegram_ops_staging',ssl:true,is_owner:true,table_owner:true,runtime:false};
async function fixture(fn:(db:Database,raw:Queryable,events:string[])=>Promise<void>,identity=good,failAudit=false) {
 const memory=new PGlite();const events:string[]=[];
 const adapt=(c:any):Queryable=>({query:async(sql,params)=>params===undefined?(await c.exec(sql)).at(-1)??{rows:[]}:c.query(sql,params)});
 const raw=adapt(memory);
 const database:Database={...raw,transaction:fn=>memory.transaction(tx=>fn(adapt(tx)))};
 await migrate(database);
 await raw.query("INSERT INTO admins(auth_subject,display_name) VALUES('local:staging-admin','test')");
 await raw.query("INSERT INTO admin_credentials(admin_id,login,password_hash) SELECT id,'staging-admin','synthetic-unused-fixture' FROM admins");
 await raw.query("INSERT INTO admin_roles(admin_id,role_id) SELECT a.id,r.id FROM admins a CROSS JOIN roles r WHERE r.name='Super Admin'");
 const db:Database={...raw,transaction:fn=>database.transaction(tx=>fn({query:async(sql,params)=>{
  events.push(sql);
  // PGlite cannot represent an external TLS connection or multi-session advisory locks.
  if(sql.startsWith('SELECT current_database()')) return {rows:[identity]} as any;
  if(sql.includes('pg_advisory_xact_lock')) return {rows:[]} as any;
  if(failAudit && sql.startsWith('INSERT INTO audit_logs')) throw new Error('synthetic rollback probe');
  return tx.query(sql,params);
 }}))};
 try {await fn(db,raw,events);} finally {await memory.close();}
}
async function counts(raw:Queryable) {
 return (await raw.query('SELECT (SELECT count(*)::int FROM brands) brands,(SELECT count(*)::int FROM telegram_bots) bots,(SELECT count(*)::int FROM audit_logs) audits')).rows[0];
}
test('seed CLI mode defaults to dry-run and rejects ambiguous arguments',()=>{
 assert.equal(seedMode([]),false);assert.equal(seedMode(['--dry-run']),false);assert.equal(seedMode(['--apply']),true);
 assert.throws(()=>seedMode(['--apply','--dry-run']),/invalid_arguments/);assert.throws(()=>seedMode(['--force']),/invalid_arguments/);
});
for(const [name,patch,code] of [
 ['wrong database',{database:'production'},'not_staging_database'],
 ['no TLS',{ssl:false},'tls_required'],
 ['not owner',{is_owner:false},'maintenance_owner_required'],
 ['wrong table owner',{table_owner:false},'maintenance_owner_required'],
 ['runtime role',{runtime:true},'maintenance_owner_required'],
] as const) test(`seed rejects ${name}`,()=>{assert.throws(()=>checkIdentity({...good,...patch}),new RegExp(code));});
test('seed dry-run is read-only, plans both rows and writes no audit',()=>fixture(async(db,raw,events)=>{
 const result=await seedStaging(db);assert.equal(result.mode,'dry-run');assert.equal(result.brand.action,'create');assert.equal(result.bot.action,'create');
 assert.deepEqual(await counts(raw),{brands:0,bots:0,audits:0});assert.equal(events[0],'SET TRANSACTION READ ONLY');assert.ok(events.some(s=>s.includes('pg_advisory_xact_lock')));
 assert.ok(!events.some(s=>/^INSERT|^UPDATE|^DELETE/.test(s)));
}));
for(const [name,sql,code] of [
 ['missing P1 migration',"DELETE FROM schema_migrations WHERE name='007_mini_auth.sql'",'migration_set_mismatch'],
 ['changed P1 checksum',"UPDATE schema_migrations SET checksum='invalid' WHERE name='007_mini_auth.sql'",'migration_checksum_mismatch'],
 ['missing migration',"DELETE FROM schema_migrations WHERE name='006_dashboard.sql'",'migration_set_mismatch'],
 ['changed checksum',"UPDATE schema_migrations SET checksum='invalid' WHERE name='006_dashboard.sql'",'migration_checksum_mismatch'],
 ['missing admin',"DELETE FROM admin_roles; DELETE FROM admin_credentials; DELETE FROM admins",'active_global_staging_admin_required'],
 ['disabled admin',"UPDATE admins SET status='disabled'",'active_global_staging_admin_required'],
 ['not Super Admin',"UPDATE admin_roles SET role_id=(SELECT id FROM roles WHERE name='Viewer')",'active_global_staging_admin_required'],
 ['no effective grant',"DELETE FROM role_permissions WHERE role_id=(SELECT id FROM roles WHERE name='Super Admin')",'active_global_staging_admin_required'],
] as const) test(`seed rejects ${name} before writes`,()=>fixture(async(db,raw)=>{
 await raw.query(sql);await assert.rejects(()=>seedStaging(db,true),new RegExp(code));assert.deepEqual(await counts(raw),{brands:0,bots:0,audits:0});
}));
test('seed creates exact Brand + disabled synthetic Bot, audits once and is idempotent',()=>fixture(async(db,raw)=>{
 const first=await seedStaging(db,true);const second=await seedStaging(db,true);
 assert.equal(first.brand.action,'create');assert.equal(first.bot.action,'create');assert.equal(second.brand.action,'reuse');assert.equal(second.bot.action,'reuse');assert.equal(first.bot.id,second.bot.id);
 assert.equal(first.bot.status,'disabled');assert.equal(first.bot.timezone,null);assert.equal(first.brand.timezone,'UTC');
 assert.equal(first.bot.token_secret_ref,seedBot.token_secret_ref);assert.equal(first.bot.webhook_secret_ref,seedBot.webhook_secret_ref);
 assert.deepEqual(await counts(raw),{brands:1,bots:1,audits:2});
 const n=(await raw.query('SELECT (SELECT count(*)::int FROM telegram_users) users,(SELECT count(*)::int FROM point_ledger) ledger,(SELECT count(*)::int FROM referrals) referrals,(SELECT count(*)::int FROM redemptions) redemptions')).rows[0];assert.deepEqual(n,{users:0,ledger:0,referrals:0,redemptions:0});
 const administrators=(await raw.query('SELECT (SELECT count(*)::int FROM admins) admins,(SELECT count(*)::int FROM admin_roles) roles')).rows[0];assert.deepEqual(administrators,{admins:1,roles:1});
}));
test('seed reuses matching Brand and creates only missing Bot',()=>fixture(async(db,raw)=>{
 await raw.query('INSERT INTO brands(name,slug,default_language,timezone,status,countries) VALUES($1,$2,$3,$4,$5,$6)',Object.values(seedBrand));
 const r=await seedStaging(db,true);assert.equal(r.brand.action,'reuse');assert.equal(r.bot.action,'create');assert.deepEqual(await counts(raw),{brands:1,bots:1,audits:1});
}));
for(const [name,sql,code] of [
 ['Brand fields',"UPDATE brands SET timezone='Asia/Shanghai'",'brand_conflict'],
 ['Bot fields',"UPDATE telegram_bots SET name='changed'",'bot_conflict'],
 ['enabled Bot',"UPDATE telegram_bots SET status='active'",'bot_conflict'],
] as const) test(`seed refuses ${name} conflict without modifying it`,()=>fixture(async(db,raw)=>{
 await seedStaging(db,true);await raw.query(sql);await assert.rejects(()=>seedStaging(db,true),new RegExp(code));assert.deepEqual(await counts(raw),{brands:1,bots:1,audits:2});
}));
test('seed audit failure rolls back both Brand and Bot',()=>fixture(async(db,raw)=>{
 await assert.rejects(()=>seedStaging(db,true),/synthetic rollback probe/);assert.deepEqual(await counts(raw),{brands:0,bots:0,audits:0});
},good,true));
test('seed refuses configured test secret references',()=>fixture(async(db,raw)=>{
 const key=seedBot.token_secret_ref;const old=process.env[key];process.env[key]='';
 try {await assert.rejects(()=>seedStaging(db,true),/test_secret_reference_must_be_unconfigured/);} finally {if(old===undefined) delete process.env[key];else process.env[key]=old;}
 assert.deepEqual(await counts(raw),{brands:0,bots:0,audits:0});
}));
test('seed PostgreSQL transaction advisory lock excludes a second connection and releases on rollback',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const a=new pg.Client({connectionString:process.env.TEST_DATABASE_URL}),b=new pg.Client({connectionString:process.env.TEST_DATABASE_URL});
 try {
 await a.connect();await b.connect();await a.query('BEGIN');await b.query('BEGIN');
 await a.query('SELECT pg_advisory_xact_lock(741092,1)');
 assert.equal((await b.query('SELECT pg_try_advisory_xact_lock(741092,1) acquired')).rows[0].acquired,false);
 await a.query('ROLLBACK');
 assert.equal((await b.query('SELECT pg_try_advisory_xact_lock(741092,1) acquired')).rows[0].acquired,true);
 await b.query('ROLLBACK');
 } finally {await a.end();await b.end();}
});
test('seed refuses a scoped Super Admin grant',()=>fixture(async(db,raw)=>{
 const brand=(await raw.query("INSERT INTO brands(name,slug,default_language) VALUES('scope','scope','en') RETURNING id")).rows[0]!;
 await raw.query('UPDATE admin_roles SET brand_id=$1',[brand.id]);
 await assert.rejects(()=>seedStaging(db,true),/active_global_staging_admin_required/);
 assert.deepEqual(await counts(raw),{brands:1,bots:0,audits:0});
}));
test('seed rejects a conflicting secret ref or foreign Brand association',()=>fixture(async(db,raw)=>{
 await seedStaging(db,true);
 await raw.query("UPDATE telegram_bots SET username='other-synthetic-bot'");
 await assert.rejects(()=>seedStaging(db,true),/bot_conflict/);
 assert.deepEqual(await counts(raw),{brands:1,bots:1,audits:2});
}));
