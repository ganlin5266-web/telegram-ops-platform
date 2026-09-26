import {isDeepStrictEqual} from 'node:util';
import type {Database,Queryable,Scope} from './db.js';
import {postPoints} from './points.js';
import {SeedError,checkIdentity,verifyMigrations,seedBrand,seedBot} from './staging-seed.js';

const version='staging-users-v1';
const note='synthetic staging test data';
export const syntheticUsers=[
 {id:'d094a203-016d-4a5d-9634-000000000001',telegram_user_id:'9007199254740901',username:'staging-test-user-a',first_name:'Staging Test User A',telegram_language_code:'zh-CN',status:'active',referral_code:'staging_users_v1_a'},
 {id:'d094a203-016d-4a5d-9634-000000000002',telegram_user_id:'9007199254740902',username:'staging-test-user-b',first_name:'Staging Test User B',telegram_language_code:'pt-BR',status:'active',referral_code:'staging_users_v1_b'},
 {id:'d094a203-016d-4a5d-9634-000000000003',telegram_user_id:'9007199254740903',username:'staging-test-user-c',first_name:'Staging Test User C',telegram_language_code:'en',status:'disabled',referral_code:'staging_users_v1_c'},
].map(u=>({...u,last_name:null,preferred_language:null,first_started_at:null}));
const events=[{user:0,delta:'1000',key:`${version}:a:credit`},{user:1,delta:'500',key:`${version}:b:credit`},{user:1,delta:'-120',key:`${version}:b:debit`}];
function matches(row:Record<string,unknown>,expected:Record<string,unknown>):boolean {
 return Object.entries(expected).every(([key,value])=>isDeepStrictEqual(row[key],value));
}
function fail(code:string):never {throw new SeedError(code);}

export async function seedStagingUsers(db:Database,apply=false) {
 if(process.env[seedBot.token_secret_ref]!==undefined || process.env[seedBot.webhook_secret_ref]!==undefined) fail('test_secret_reference_must_be_unconfigured');
 return db.transaction(async tx=>{
  if(!apply) await tx.query('SET TRANSACTION READ ONLY');
  checkIdentity((await tx.query(`SELECT current_database() AS database,
   (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS ssl,
   (SELECT datdba=(SELECT oid FROM pg_roles WHERE rolname=current_user) FROM pg_database WHERE datname=current_database()) AS is_owner,
   current_user='telegram_app' AS runtime,
   (SELECT count(*)=11 AND bool_and(c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user))
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
    AND c.relname IN ('brands','telegram_bots','admins','admin_credentials','admin_roles','audit_logs','telegram_users','point_accounts','point_ledger','referrals','schema_migrations')) AS table_owner`)).rows[0]);
  await tx.query('SELECT pg_advisory_xact_lock(741092,1)');
  await verifyMigrations(tx);
  const admin=(await tx.query(`SELECT a.id FROM admins a JOIN admin_credentials c ON c.admin_id=a.id
   WHERE c.login='staging-admin' AND a.auth_subject='local:staging-admin' AND a.status='active'
   AND EXISTS(SELECT 1 FROM admin_roles ar JOIN roles r ON r.id=ar.role_id
    WHERE ar.admin_id=a.id AND ar.brand_id IS NULL AND ar.bot_id IS NULL AND r.name='Super Admin'
    AND EXISTS(SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id
     WHERE rp.role_id=r.id AND p.name='system.manage'))`)).rows[0];
  if(!admin) fail('active_global_staging_admin_required');
  const brand=(await tx.query('SELECT * FROM brands WHERE slug=$1',[seedBrand.slug])).rows[0];
  if(!brand || !matches(brand,seedBrand)) fail('brand_conflict');
  const bots=(await tx.query('SELECT * FROM telegram_bots WHERE username=$1 OR token_secret_ref=$2 OR webhook_secret_ref=$3',[seedBot.username,seedBot.token_secret_ref,seedBot.webhook_secret_ref])).rows;
  const bot=bots[0];
  if(bots.length!==1 || !bot || bot.brand_id!==brand.id || !matches(bot,seedBot)) fail('bot_conflict');
  const scope:Scope={brandId:brand.id,botId:bot.id};
  // Same ordering as the runtime points/webhook paths; read-only plans take no row locks.
  if(apply) {
   await tx.query('SELECT id FROM brands WHERE id=$1 FOR SHARE',[brand.id]);
   await tx.query('SELECT id FROM telegram_bots WHERE id=$1 FOR UPDATE',[bot.id]);
   const locked=(await tx.query('SELECT * FROM telegram_bots WHERE id=$1',[bot.id])).rows[0];
   const lockedBrand=(await tx.query('SELECT * FROM brands WHERE id=$1',[brand.id])).rows[0];
   if(!locked || !matches(locked,{...seedBot,brand_id:brand.id}) || !lockedBrand || !matches(lockedBrand,seedBrand)) fail('scope_changed');
  }
  let created=0;
  async function audit(type:string,id:string,data:Record<string,unknown>,isNew:boolean) {
   const action=`${version}.create`;
   const rows=(await tx.query('SELECT * FROM audit_logs WHERE action=$1 AND object_type=$2 AND object_id=$3',[action,type,id])).rows;
   if(!isNew) {
    if(rows.length!==1 || !matches(rows[0]!,{admin_id:admin!.id,brand_id:scope.brandId,bot_id:scope.botId,after_data:data,note})) fail('seed_audit_conflict');
   } else {
    if(rows.length) fail('seed_audit_conflict');
    if(apply) await tx.query(`INSERT INTO audit_logs(admin_id,brand_id,bot_id,action,object_type,object_id,after_data,note)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[admin!.id,scope.brandId,scope.botId,action,type,id,JSON.stringify(data),note]);
    created++;
   }
  }
  for(const user of syntheticUsers) {
   const rows=(await tx.query(`SELECT *,telegram_user_id::text AS telegram_user_id FROM telegram_users
    WHERE id=$1 OR (bot_id=$2 AND (telegram_user_id=$3 OR referral_code=$4 OR username=$5))`,[user.id,bot.id,user.telegram_user_id,user.referral_code,user.username])).rows;
   if(rows.length>1 || (rows[0] && !matches(rows[0],{...user,brand_id:brand.id,bot_id:bot.id}))) fail('user_conflict');
   if(!rows.length && apply) {
    await tx.query(`INSERT INTO telegram_users(id,brand_id,bot_id,telegram_user_id,username,first_name,last_name,telegram_language_code,preferred_language,status,referral_code,first_started_at)
     VALUES($1,$2,$3,$4,$5,$6,NULL,$7,NULL,$8,$9,NULL)`,[user.id,brand.id,bot.id,user.telegram_user_id,user.username,user.first_name,user.telegram_language_code,user.status,user.referral_code]);
   }
   await audit('telegram_user',user.id,user,!rows.length);
  }
  // Never silently absorb unrelated balances or events into these fixed fixtures.
  const ids=syntheticUsers.map(u=>u.id);
  const ledger=(await tx.query('SELECT *,delta::text AS delta FROM point_ledger WHERE user_id=ANY($1::uuid[]) OR (bot_id=$2 AND business_type=$3)',[ids,bot.id,'staging_seed'])).rows;
  for(const row of ledger) {
   const event=events.find(e=>e.key===row.business_id);
   if(!event || !matches(row,{brand_id:brand.id,bot_id:bot.id,user_id:syntheticUsers[event.user]!.id,delta:event.delta,source:'staging_seed',business_type:'staging_seed',idempotency_key:event.key,note})) fail('points_conflict');
  }
  const accounts=(await tx.query('SELECT *,balance::text AS balance FROM point_accounts WHERE user_id=ANY($1::uuid[])',[ids])).rows;
  for(const a of accounts) {
   const sum=ledger.filter(l=>l.user_id===a.user_id).reduce((n,l)=>n+BigInt(l.delta),0n);
   if(a.user_id===ids[2] || a.brand_id!==brand.id || a.bot_id!==bot.id || BigInt(a.balance)!==sum || !ledger.some(l=>l.account_id===a.id)) fail('balance_conflict');
  }
  for(const e of events) {
   const userId=syntheticUsers[e.user]!.id;
   const existing=ledger.find(l=>l.business_id===e.key);
   const result=apply?await postPoints(tx,{...scope,userId,delta:e.delta,source:'staging_seed',businessType:'staging_seed',businessId:e.key,idempotencyKey:e.key,note}):existing;
   await audit('point_event',e.key,{userId,delta:e.delta,businessId:e.key},!existing);
   if(apply && !result) fail('points_creation_failed');
  }
  const inviter=syntheticUsers[0]!,invitee=syntheticUsers[1]!;
  if(inviter.id===invitee.id) fail('self_referral');
  const expected={brand_id:brand.id,bot_id:bot.id,inviter_id:inviter.id,invitee_id:invitee.id,start_parameter:`ref_${inviter.referral_code}`,status:'bound',reward_status:'pending'};
  const relations=(await tx.query('SELECT * FROM referrals WHERE inviter_id=ANY($1::uuid[]) OR invitee_id=ANY($1::uuid[])',[ids])).rows;
  if(relations.length>1 || (relations[0] && !matches(relations[0],expected))) fail('referral_conflict');
  if(!relations.length && apply) {
   const members=(await tx.query('SELECT id FROM telegram_users WHERE brand_id=$1 AND bot_id=$2 AND id=ANY($3::uuid[])',[brand.id,bot.id,[inviter.id,invitee.id]])).rows;
   if(members.length!==2) fail('referral_scope_conflict');
   await tx.query(`INSERT INTO referrals(brand_id,bot_id,inviter_id,invitee_id,start_parameter,status,reward_status)
    VALUES($1,$2,$3,$4,$5,'bound','pending')`,[brand.id,bot.id,inviter.id,invitee.id,expected.start_parameter]);
  }
  await audit('referral',`${version}:a-b`,expected,!relations.length);
  if(apply) await verifyBalances(tx,scope);
  // A stable maintenance record is created once, never on a reuse-only invocation.
  await audit('maintenance',`${version}:${bot.id}`,{version,users:ids},created>0);
  return {mode:apply?'apply':'dry-run',createdObjects:created,brandId:brand.id,botId:bot.id,users:ids,expectedBalances:['1000','380','0']};
 });
}
async function verifyBalances(tx:Queryable,s:Scope) {
 for(const [index,user] of syntheticUsers.entries()) {
  const rows=(await tx.query('SELECT balance::text FROM point_accounts WHERE brand_id=$1 AND bot_id=$2 AND user_id=$3',[s.brandId,s.botId,user.id])).rows;
  const sum=(await tx.query('SELECT COALESCE(SUM(delta),0)::text AS total FROM point_ledger WHERE brand_id=$1 AND bot_id=$2 AND user_id=$3',[s.brandId,s.botId,user.id])).rows[0]!.total;
  const expected=['1000','380','0'][index];
  if((index===2?rows.length!==0:rows.length!==1 || rows[0]!.balance!==expected) || sum!==expected) fail('balance_verification_failed');
 }
}
