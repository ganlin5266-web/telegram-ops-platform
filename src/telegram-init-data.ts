import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {DomainError} from './db.js';
export const INIT_MAX_AGE_SECONDS=300;
export const INIT_FUTURE_SKEW_SECONDS=30;
const userSchema=z.object({id:z.number().int().positive().safe(),is_bot:z.literal(false).optional(),
 first_name:z.string().min(1).max(256),last_name:z.string().max(256).optional(),
 username:z.string().max(128).optional(),language_code:z.string().max(64).optional()});
export type MiniUser=z.infer<typeof userSchema>;
export type MiniInitDataFailureReason='missing_input'|'malformed_fields'|'invalid_hash'|'hash_mismatch'|'hash_matches_without_signature'|'invalid_auth_date'|'future_auth_date'|'expired_auth_date'|'invalid_user';
class MiniInitDataError extends DomainError {
 constructor(public readonly diagnosticReason:MiniInitDataFailureReason) {super('mini_invalid_identity',401);}
}
const invalid=(reason:MiniInitDataFailureReason)=>new MiniInitDataError(reason);
// Diagnostic reason is safe for server logs: it contains no input, user, hash or secret.
export function miniInitDataFailureReason(error:unknown) {return error instanceof MiniInitDataError?error.diagnosticReason:undefined;}
// No network calls. Never log the input, parsed user or secret.
export function verifyInitData(raw:string,botToken:string,nowSeconds=Math.floor(Date.now()/1000)) {
 return verify(raw,botToken,nowSeconds,INIT_MAX_AGE_SECONDS);
}
// Only used after an independently authenticated recovery Cookie. Never for exchange.
export function verifyRecoveryInitData(raw:string,botToken:string,nowSeconds=Math.floor(Date.now()/1000)) {
 return verify(raw,botToken,nowSeconds,1800+INIT_MAX_AGE_SECONDS);
}
function verify(raw:string,botToken:string,nowSeconds:number,maxAge:number) {
 if(!raw || Buffer.byteLength(raw)>16384 || !botToken) throw invalid('missing_input');
 const fields=new Map<string,string>();
 for(const part of raw.split('&')) {
  const split=part.indexOf('=');if(split<1) throw invalid('malformed_fields');
  const decode=(s:string)=>decodeURIComponent(s.replace(/\+/g,' '));
  let key:string,value:string;
  try {key=decode(part.slice(0,split));value=decode(part.slice(split+1));} catch {throw invalid('malformed_fields');}
  if(!/^[a-z_]+$/.test(key)||fields.has(key)||value.includes('\n')||value.includes('\r')) throw invalid('malformed_fields');
  fields.set(key,value);
 }
 const hash=fields.get('hash');if(!hash||!/^[a-fA-F0-9]{64}$/.test(hash)) throw invalid('invalid_hash');
 // HMAC validation excludes hash only. Telegram's optional signature is included
 // here; excluding signature belongs to the separate Ed25519 algorithm, not HMAC.
 const data=[...fields].filter(([k])=>k!=='hash').sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('\n');
 const secret=createHmac('sha256','WebAppData').update(botToken).digest();
 const expected=createHmac('sha256',secret).update(data).digest();
 if(!timingSafeEqual(expected,Buffer.from(hash,'hex'))) {
  // Diagnostic-only compatibility signal. It never authorizes a request.
  if(fields.has('signature')) {
   const withoutSignature=[...fields].filter(([k])=>k!=='hash'&&k!=='signature').sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('\n');
   const alternate=createHmac('sha256',secret).update(withoutSignature).digest();
   if(timingSafeEqual(alternate,Buffer.from(hash,'hex'))) throw invalid('hash_matches_without_signature');
  }
  throw invalid('hash_mismatch');
 }
 const date=fields.get('auth_date');if(!date||!/^\d{1,12}$/.test(date)) throw invalid('invalid_auth_date');
 const authDate=Number(date);
 if(!Number.isSafeInteger(authDate)) throw invalid('invalid_auth_date');
 if(authDate>nowSeconds+INIT_FUTURE_SKEW_SECONDS) throw invalid('future_auth_date');
 if(nowSeconds>=authDate+maxAge) throw invalid('expired_auth_date');
 let user:MiniUser;
 try {user=userSchema.parse(JSON.parse(fields.get('user')??''));} catch {throw invalid('invalid_user');}
 return {user,authDate,payloadDigest:createHash('sha256').update(data).digest('hex')};
}
