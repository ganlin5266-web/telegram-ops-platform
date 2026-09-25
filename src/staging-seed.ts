import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {Database,Queryable} from './db.js';

export class SeedError extends Error {
 constructor(public code:string) {super(code);}
}
export const seedBrand={name:'Staging Test Brand',slug:'staging-test-brand',default_language:'zh-CN',timezone:'UTC',status:'active',countries:[] as string[]};
// Deliberately invalid as a real Telegram username (hyphens); internal synthetic label only.
export const seedBot={name:'Staging Test Bot',username:'staging-test-bot-not-telegram',token_secret_ref:'STAGING_TEST_BOT_TOKEN_UNCONFIGURED',webhook_secret_ref:'STAGING_TEST_BOT_WEBHOOK_UNCONFIGURED',default_language:'zh-CN',supported_languages:['zh-CN'],timezone:null,status:'disabled'};
const migrations=['001_core.sql','002_harden_ledger.sql','003_ledger_conflict_safety.sql','004_admin_sessions.sql','005_operations_queries.sql','006_dashboard.sql'];
export function seedMode(args:string[]):boolean {
 if(args.length===0 || (args.length===1 && args[0]==='--dry-run')) return false;
 if(args.length===1 && args[0]==='--apply') return true;
 throw new SeedError('invalid_arguments');
}
export function checkIdentity(row:Record<string,unknown>|undefined) {
 if(row?.database!=='telegram_ops_staging') throw new SeedError('not_staging_database');
 if(row.ssl!==true) throw new SeedError('tls_required');
 if(row.is_owner!==true || row.table_owner!==true || row.runtime===true) throw new SeedError('maintenance_owner_required');
}
function matches(row:Record<string,unknown>,expected:Record<string,unknown>) {
 return Object.entries(expected).every(([key,value])=>JSON.stringify(row[key])===JSON.stringify(value));
}
async function verifyMigrations(tx:Queryable) {
 const rows=(await tx.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
 if(rows.length!==migrations.length) throw new SeedError('migration_set_mismatch');
 for(const name of migrations) {
  const checksum=createHash('sha256').update(await readFile(`db/migrations/${name}`,'utf8')).digest('hex');
  if(!rows.some(row=>row.name===name && row.checksum===checksum)) throw new SeedError('migration_checksum_mismatch');
 }
}
export async function seedStaging(db:Database,apply=false) {
 if(process.env[seedBot.token_secret_ref]!==undefined || process.env[seedBot.webhook_secret_ref]!==undefined) throw new SeedError('test_secret_reference_must_be_unconfigured');
 return db.transaction(async tx=>{
  if(!apply) await tx.query('SET TRANSACTION READ ONLY');
  checkIdentity((await tx.query(`SELECT current_database() AS database,
   (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS ssl,
   (SELECT datdba=(SELECT oid FROM pg_roles WHERE rolname=current_user) FROM pg_database WHERE datname=current_database()) AS is_owner,
   current_user='telegram_app' AS runtime,
   (SELECT count(*)=6 AND bool_and(c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user))
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
    AND c.relname IN ('brands','telegram_bots','admins','admin_credentials','admin_roles','audit_logs')) AS table_owner`)).rows[0]);
  await tx.query("SELECT pg_advisory_xact_lock(741092,1)");
  await verifyMigrations(tx);
  const admin=(await tx.query(`SELECT a.id FROM admins a JOIN admin_credentials c ON c.admin_id=a.id
   WHERE c.login='staging-admin' AND a.auth_subject='local:staging-admin' AND a.status='active'
   AND EXISTS(SELECT 1 FROM admin_roles ar JOIN roles r ON r.id=ar.role_id
    WHERE ar.admin_id=a.id AND ar.brand_id IS NULL AND ar.bot_id IS NULL AND r.name='Super Admin'
    AND EXISTS(SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id
     WHERE rp.role_id=r.id AND p.name='system.manage'))`)).rows[0];
  if(!admin) throw new SeedError('active_global_staging_admin_required');
  let brand=(await tx.query('SELECT * FROM brands WHERE slug=$1',[seedBrand.slug])).rows[0];
  const bots=(await tx.query('SELECT * FROM telegram_bots WHERE username=$1 OR token_secret_ref=$2 OR webhook_secret_ref=$3',[seedBot.username,seedBot.token_secret_ref,seedBot.webhook_secret_ref])).rows;
  if(brand && !matches(brand,seedBrand)) throw new SeedError('brand_conflict');
  let bot=bots[0];
  if(bots.length>1 || (bot && (!brand || bot.brand_id!==brand.id || !matches(bot,seedBot)))) throw new SeedError('bot_conflict');
  const createBrand=!brand,createBot=!bot;
  if(apply) {
   if(!brand) brand=(await tx.query(`INSERT INTO brands(name,slug,default_language,timezone,status,countries)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,Object.values(seedBrand))).rows[0];
   if(!brand) throw new SeedError('brand_creation_failed');
   if(!bot) bot=(await tx.query(`INSERT INTO telegram_bots(brand_id,name,username,token_secret_ref,webhook_secret_ref,default_language,supported_languages,timezone,status)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[brand.id,...Object.values(seedBot)])).rows[0];
   if(!bot) throw new SeedError('bot_creation_failed');
   for(const item of [{created:createBrand,type:'brand',row:brand,bot:null},{created:createBot,type:'bot',row:bot,bot:bot.id}]) {
    if(item.created) await tx.query(`INSERT INTO audit_logs(admin_id,brand_id,bot_id,action,object_type,object_id,after_data,note)
     VALUES($1,$2,$3,'staging.seed.create',$4,$5,$6,'staging-seed-v1 maintenance CLI')`,[admin.id,brand.id,item.bot,item.type,item.row.id,JSON.stringify(item.type==='brand'?seedBrand:seedBot)]);
   }
  }
  return {mode:apply?'apply':'dry-run',brand:{action:createBrand?'create':'reuse',id:brand?.id??null,...seedBrand},bot:{action:createBot?'create':'reuse',id:bot?.id??null,...seedBot}};
 });
}
