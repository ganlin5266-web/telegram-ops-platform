import {createHash,randomBytes} from 'node:crypto';
import {DomainError,one,type Database,type Queryable,type Scope} from './db.js';
import {verifyInitData,INIT_MAX_AGE_SECONDS} from './telegram-init-data.js';
import {mapMiniUser} from './mini-users.js';
export const MINI_SESSION_SECONDS=1800;
export type MiniAppBinding={appKey:string;botId:string;origin:string;tokenSecretRef:string};
export type MiniPrincipal=Scope&{userId:string;sessionId:string;appKey:string;expiresAt:string};
export const miniDigest=(value:string)=>createHash('sha256').update(value).digest('hex');
export const miniUnauthorized=()=>new DomainError('mini_unauthorized',401);
export async function miniAudit(tx:Queryable,s:Scope,action:string,id:string,requestId:string) {
 await tx.query(`INSERT INTO audit_logs(brand_id,bot_id,action,object_type,object_id,request_id)
 VALUES($1,$2,$3,'mini_session',$4,$5)`,[s.brandId,s.botId,action,id,requestId]);
}
export async function miniRateLimit(db:Database,key:string,max:number) {
 // Commit denial counters independently of exchange rollback; shared across replicas.
 const row=await one(db,`INSERT INTO mini_auth_limits(bucket_hash,attempts) VALUES($1,1)
 ON CONFLICT(bucket_hash) DO UPDATE SET attempts=CASE WHEN mini_auth_limits.window_started_at<now()-interval '15 minutes' THEN 1 ELSE mini_auth_limits.attempts+1 END,
 window_started_at=CASE WHEN mini_auth_limits.window_started_at<now()-interval '15 minutes' THEN now() ELSE mini_auth_limits.window_started_at END RETURNING attempts`,[miniDigest(key)]);
 if(row.attempts>max) throw new DomainError('mini_rate_limited',429);
}
export async function exchangeMiniSession(db:Database,binding:MiniAppBinding,raw:string,secret:string,requestId:string) {
 const verified=verifyInitData(raw,secret);
 await miniRateLimit(db,`user:${binding.botId}:${verified.user.id}`,10);
 return db.transaction(async tx=>{
  const bot=(await tx.query(`SELECT b.brand_id,b.id FROM telegram_bots b JOIN brands br ON br.id=b.brand_id
   WHERE b.id=$1 AND b.status='active' AND br.status='active' AND b.token_secret_ref=$2 FOR UPDATE OF b`,[binding.botId,binding.tokenSecretRef])).rows[0];
  if(!bot) throw miniUnauthorized();
  // Recheck after waiting for the lock; a queued exchange cannot outlive initData.
  const current=verifyInitData(raw,secret);
  const exchange=(await tx.query(`INSERT INTO mini_auth_exchanges(brand_id,bot_id,payload_digest,auth_date,valid_until)
   VALUES($1,$2,$3,to_timestamp($4),to_timestamp($5)) ON CONFLICT(bot_id,payload_digest) DO NOTHING RETURNING id`,
   [bot.brand_id,bot.id,current.payloadDigest,current.authDate,current.authDate+INIT_MAX_AGE_SECONDS])).rows[0];
  if(!exchange) throw new DomainError('mini_init_data_used',401);
  const scope={brandId:String(bot.brand_id),botId:String(bot.id)};
  const user=await mapMiniUser(tx,scope,current.user);
  const token=randomBytes(32).toString('hex');
  const session=await one(tx,`INSERT INTO mini_sessions(brand_id,bot_id,user_id,app_key,exchange_id,token_hash,expires_at)
   VALUES($1,$2,$3,$4,$5,$6,now()+($7 * interval '1 second')) RETURNING id,expires_at`,
   [scope.brandId,scope.botId,user.id,binding.appKey,exchange.id,miniDigest(token),MINI_SESSION_SECONDS]);
  await miniAudit(tx,scope,'mini.auth.exchange',session.id,requestId);
  return {token,tokenType:'Bearer',expiresAt:new Date(session.expires_at).toISOString()};
 });
}
export async function authenticateMini(db:Database,authorization:string|undefined,bindings:MiniAppBinding[],origin:string|undefined):Promise<MiniPrincipal> {
 const token=authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];if(!token) throw miniUnauthorized();
 const row=(await db.query(`SELECT s.id,s.brand_id,s.bot_id,s.user_id,s.app_key,s.expires_at,b.token_secret_ref
 FROM mini_sessions s JOIN telegram_users u ON (u.brand_id,u.bot_id,u.id)=(s.brand_id,s.bot_id,s.user_id)
 JOIN telegram_bots b ON (b.brand_id,b.id)=(s.brand_id,s.bot_id) JOIN brands br ON br.id=s.brand_id
 WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()
 AND u.status='active' AND b.status='active' AND br.status='active'`,[miniDigest(token)])).rows[0];
 if(!row) throw miniUnauthorized();
 const binding=bindings.find(b=>b.appKey===row.app_key&&b.botId===row.bot_id&&b.tokenSecretRef===row.token_secret_ref);
 if(!binding) throw miniUnauthorized();
 if(origin&&origin!==binding.origin) throw new DomainError('mini_origin_not_allowed',403);
 return {sessionId:row.id,brandId:row.brand_id,botId:row.bot_id,userId:row.user_id,appKey:row.app_key,expiresAt:new Date(row.expires_at).toISOString()};
}
export async function logoutMini(db:Database,p:MiniPrincipal,requestId:string) {
 return db.transaction(async tx=>{
  const rows=(await tx.query(`UPDATE mini_sessions SET revoked_at=now(),revoke_reason='logout'
   WHERE id=$1 AND brand_id=$2 AND bot_id=$3 AND user_id=$4 AND revoked_at IS NULL RETURNING id`,
   [p.sessionId,p.brandId,p.botId,p.userId])).rows;
  if(rows.length) await miniAudit(tx,p,'mini.auth.logout',p.sessionId,requestId);
  return {ok:true};
 });
}
