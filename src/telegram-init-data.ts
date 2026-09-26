import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {DomainError} from './db.js';
export const INIT_MAX_AGE_SECONDS=300;
export const INIT_FUTURE_SKEW_SECONDS=30;
const userSchema=z.object({id:z.number().int().positive().safe(),is_bot:z.literal(false).optional(),
 first_name:z.string().min(1).max(256),last_name:z.string().max(256).optional(),
 username:z.string().max(128).optional(),language_code:z.string().max(64).optional()});
export type MiniUser=z.infer<typeof userSchema>;
const invalid=()=>new DomainError('mini_invalid_identity',401);
// No network calls. Never log the input, parsed user or secret.
export function verifyInitData(raw:string,botToken:string,nowSeconds=Math.floor(Date.now()/1000)) {
 if(!raw || Buffer.byteLength(raw)>16384 || !botToken) throw invalid();
 const fields=new Map<string,string>();
 try {
  for(const part of raw.split('&')) {
   const split=part.indexOf('=');if(split<1) throw invalid();
   const decode=(s:string)=>decodeURIComponent(s.replace(/\+/g,' '));
   const key=decode(part.slice(0,split)),value=decode(part.slice(split+1));
   if(!/^[a-z_]+$/.test(key)||fields.has(key)||value.includes('\n')||value.includes('\r')) throw invalid();
   fields.set(key,value);
  }
 } catch {throw invalid();}
 const hash=fields.get('hash');if(!hash||!/^[a-fA-F0-9]{64}$/.test(hash)) throw invalid();
 // HMAC validation excludes hash only. Telegram's optional signature is included
 // here; excluding signature belongs to the separate Ed25519 algorithm, not HMAC.
 const data=[...fields].filter(([k])=>k!=='hash').sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('\n');
 const secret=createHmac('sha256','WebAppData').update(botToken).digest();
 const expected=createHmac('sha256',secret).update(data).digest();
 if(!timingSafeEqual(expected,Buffer.from(hash,'hex'))) throw invalid();
 const date=fields.get('auth_date');if(!date||!/^\d{1,12}$/.test(date)) throw invalid();
 const authDate=Number(date);
 if(!Number.isSafeInteger(authDate)||authDate>nowSeconds+INIT_FUTURE_SKEW_SECONDS||nowSeconds>=authDate+INIT_MAX_AGE_SECONDS) throw invalid();
 let user:MiniUser;
 try {user=userSchema.parse(JSON.parse(fields.get('user')??''));} catch {throw invalid();}
 return {user,authDate,payloadDigest:createHash('sha256').update(data).digest('hex')};
}
