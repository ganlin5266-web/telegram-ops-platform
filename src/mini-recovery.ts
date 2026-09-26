import {DomainError,type Database} from './db.js';
import {authenticateMini,miniAudit,miniRateLimit,miniUnauthorized,type MiniAppBinding,MINI_SESSION_SECONDS} from './mini-sessions.js';
import {verifyRecoveryInitData} from './telegram-init-data.js';
export const MINI_RECOVERY_COOKIE='__Host-telegram_mini_recovery';
export const recoveryCookie=(token:string,maxAge=MINI_SESSION_SECONDS)=>`${MINI_RECOVERY_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
export function readRecoveryCookie(header:string|undefined) {
 const matches=(header??'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(MINI_RECOVERY_COOKIE+'='));
 if(matches.length!==1) throw miniUnauthorized();
 const value=matches[0]!.slice(MINI_RECOVERY_COOKIE.length+1);if(!/^[a-f0-9]{64}$/.test(value)) throw miniUnauthorized();return value;
}
// A cookie is only a recovery credential, never accepted by Mini data routes.
// Recovery reuses the existing revocable session, without extending expiry or consuming initData again.
export async function recoverMini(db:Database,token:string,binding:MiniAppBinding,raw:string,secret:string,origin:string,requestId:string) {
 const p=await authenticateMini(db,`Bearer ${token}`,[binding],origin);
 const verified=verifyRecoveryInitData(raw,secret);
 const row=(await db.query(`SELECT e.payload_digest,u.telegram_user_id::text AS telegram_user_id
 FROM mini_sessions s JOIN mini_auth_exchanges e ON e.id=s.exchange_id
 JOIN telegram_users u ON (u.brand_id,u.bot_id,u.id)=(s.brand_id,s.bot_id,s.user_id)
 WHERE s.id=$1 AND s.brand_id=$2 AND s.bot_id=$3 AND s.user_id=$4 AND s.revoked_at IS NULL AND s.expires_at>now()`,[p.sessionId,p.brandId,p.botId,p.userId])).rows[0];
 if(!row||row.payload_digest!==verified.payloadDigest||row.telegram_user_id!==String(verified.user.id)) throw miniUnauthorized();
 await miniRateLimit(db,`recovery:${p.sessionId}`,30);
 // Audit contains only internal session identity, never credential/initData.
 await miniAudit(db,p,'mini.auth.recovery',p.sessionId,requestId);
 return {token,tokenType:'Bearer',expiresAt:p.expiresAt};
}
export function requireRecoveryProtection(headers:Record<string,unknown>) {
 if(headers['x-mini-csrf']!=='1') throw new DomainError('mini_csrf_required',403);
 if(headers['sec-fetch-site']==='cross-site') throw new DomainError('mini_origin_not_allowed',403);
}
