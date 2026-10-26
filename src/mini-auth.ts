import {attachMiniMembers} from './member-routes.js';
import {attachMiniPlatforms} from './platform-routes.js';
import {recoverMini,recoveryCookie,readRecoveryCookie,requireRecoveryProtection} from './mini-recovery.js';
import {miniInitDataFailureReason,verifyInitData} from './telegram-init-data.js';
import {attachMiniQueries} from './mini-queries.js';
import {attachMiniRedemptions} from './redemption-flow-routes.js';
import type {RedemptionCodeVault} from './redemption-vault.js';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {DomainError,type Database} from './db.js';
import type {SecretProvider} from './telegram.js';
import {authenticateMini,exchangeMiniSession,logoutMini,miniRateLimit,miniUnauthorized,type MiniAppBinding} from './mini-sessions.js';
export type MiniConfig={bindings:MiniAppBinding[]};
const exactOrigin=z.string().refine(value=>{
 try {const u=new URL(value);return u.protocol==='https:'&&u.origin===value&&!u.username&&!u.password&&!value.includes('*');} catch {return false;}
});
const configSchema=z.object({bindings:z.array(z.object({appKey:z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
 botId:z.uuid(),origin:exactOrigin,tokenSecretRef:z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/)}).strict()).min(1).max(100)}).strict();
export function validateMiniConfig(config:MiniConfig) {
 if(!configSchema.safeParse(config).success || new Set(config.bindings.map(b=>b.appKey)).size!==config.bindings.length ||
 new Set(config.bindings.map(b=>b.botId)).size!==config.bindings.length || new Set(config.bindings.map(b=>b.tokenSecretRef)).size!==config.bindings.length)
  throw new Error('Invalid Mini App configuration');
}
export function miniConfig(env:NodeJS.ProcessEnv):MiniConfig|undefined {
 if(env.MINI_AUTH_ENABLED===undefined||env.MINI_AUTH_ENABLED==='false') return undefined;
 if(env.MINI_AUTH_ENABLED!=='true') throw new Error('Invalid Mini App configuration');
 try {const config=JSON.parse(env.MINI_APPS_JSON??'');validateMiniConfig(config);return config;} catch {throw new Error('Invalid Mini App configuration');}
}
// appKey remains optional for rolling compatibility with older clients. It is
// never trusted to select a Bot: the Telegram signature or the existing
// recovery session is the authority for the binding.
const exchangeBody=z.object({appKey:z.string().max(64).optional(),initData:z.string().min(1).max(16384),recovery:z.boolean().optional()}).strict();
const empty=z.object({}).strict();
type SignedBindingResult={binding?:MiniAppBinding;reason:'matched'|'origin_not_configured'|'secret_missing'|'init_data_rejected'|'ambiguous';candidateCount:number;failures:Record<string,number>};
function signedBinding(config:MiniConfig,secrets:SecretProvider,origin:string,initData:string):SignedBindingResult {
 const candidates=config.bindings.filter(binding=>binding.origin===origin),matches:MiniAppBinding[]=[];
 const failures:Record<string,number>={};let missing=0;
 for(const binding of candidates) {
  const secret=secrets(binding.tokenSecretRef);if(!secret) {missing++;continue;}
  try {verifyInitData(initData,secret);matches.push(binding);}
  catch(error) {const reason=miniInitDataFailureReason(error)??'rejected';failures[reason]=(failures[reason]??0)+1;}
 }
 if(matches.length===1) return {binding:matches[0],reason:'matched',candidateCount:candidates.length,failures};
 if(matches.length>1) return {reason:'ambiguous',candidateCount:candidates.length,failures};
 if(candidates.length===0) return {reason:'origin_not_configured',candidateCount:0,failures};
 if(missing===candidates.length) return {reason:'secret_missing',candidateCount:candidates.length,failures};
 return {reason:'init_data_rejected',candidateCount:candidates.length,failures};
}
const safeDomainReason=(error:unknown)=>error instanceof DomainError&&['mini_invalid_identity','mini_init_data_used','mini_unauthorized','mini_rate_limited','not_found'].includes(error.code)?error.code:'rejected';
export function attachMiniAuth(app:FastifyInstance,db:Database,secrets:SecretProvider,config:MiniConfig,vault?:RedemptionCodeVault) {
 validateMiniConfig(config);
 app.addHook('onRequest',async(req,reply)=>{
  reply.header('Cache-Control','no-store').header('Vary','Origin').header('X-Content-Type-Options','nosniff');
  const origin=req.headers.origin;
  if(origin&&!config.bindings.some(b=>b.origin===origin)) throw new DomainError('mini_origin_not_allowed',403);
  if(origin) reply.header('Access-Control-Allow-Origin',origin);
  if(req.method==='OPTIONS') {
   const method=String(req.headers['access-control-request-method']);
   const headers=String(req.headers['access-control-request-headers']??'').toLowerCase().split(',').map(s=>s.trim()).filter(Boolean);
   if(!origin||!['GET','POST'].includes(method)||headers.some(h=>!['content-type','authorization','x-mini-csrf','idempotency-key'].includes(h))) throw new DomainError('mini_cors_denied',403);
   return reply.header('Access-Control-Allow-Methods','GET, POST').header('Access-Control-Allow-Headers','Content-Type, Authorization, X-Mini-CSRF, Idempotency-Key').code(204).send();
  }
  if(!['GET','HEAD'].includes(req.method)) {
   if(!origin) throw new DomainError('mini_origin_required',403);
   if(req.headers['content-type']?.split(';')[0]?.trim().toLowerCase()!=='application/json') throw new DomainError('mini_json_required',415);
  }
 });
 // Explicit preflight routes: no catch-all business API or administrator exemption.
 for(const url of ['/auth/exchange','/me','/auth/logout','/auth/recover','/platforms','/platform-identities','/redemption-tiers','/redemption-orders','/redemption-orders/:id/claim','/redemption-orders/:id/code']) app.options(url,async()=>({}));
 app.post('/auth/exchange',{bodyLimit:20000},async(req,reply)=>{
  empty.parse(req.query);const body=exchangeBody.parse(req.body);
  const origin=req.headers.origin;
  const resolved=origin?signedBinding(config,secrets,origin,body.initData):{reason:'origin_not_configured' as const,candidateCount:0,failures:{}};
  const binding=resolved.binding;
  if(!binding) {
   req.log.warn({requestId:req.id,stage:'signed_binding',reason:resolved.reason,candidateCount:resolved.candidateCount,failures:resolved.failures},'mini_auth_denied');
   // A legacy selector may partition denial counters, but never selects the
   // authenticated Bot or changes the authorization result.
   const hinted=config.bindings.find(b=>b.origin===origin&&b.appKey===body.appKey);
   await miniRateLimit(db,`invalid:${hinted?.botId??'unmatched'}:${req.ip}`,50);throw miniUnauthorized();
  }
  const secret=secrets(binding.tokenSecretRef);if(!secret) throw miniUnauthorized();
  if(body.recovery) requireRecoveryProtection(req.headers);
  let session;
  try {session=await exchangeMiniSession(db,binding,body.initData,secret,req.id);}
  catch(error) {req.log.warn({requestId:req.id,stage:'session_exchange',reason:safeDomainReason(error)},'mini_auth_denied');throw error;}
  if(body.recovery) reply.header('Set-Cookie',recoveryCookie(session.token));
  return reply.send(session);
 });
 app.post('/auth/recover',{bodyLimit:20000},async(req,reply)=>{
  empty.parse(req.query);requireRecoveryProtection(req.headers);
  const body=exchangeBody.omit({recovery:true}).parse(req.body);
  const token=readRecoveryCookie(req.headers.cookie),origin=req.headers.origin;
  try {
   const principal=await authenticateMini(db,`Bearer ${token}`,config.bindings,origin);
   const binding=config.bindings.find(b=>b.appKey===principal.appKey&&b.botId===principal.botId);
   if(!binding||origin!==binding.origin) throw miniUnauthorized();
   const secret=secrets(binding.tokenSecretRef);if(!secret) throw miniUnauthorized();
   return await recoverMini(db,token,binding,body.initData,secret,binding.origin,req.id);
  }
  catch(error) {req.log.warn({requestId:req.id,stage:'session_recovery',reason:safeDomainReason(error)},'mini_auth_denied');reply.header('Set-Cookie',recoveryCookie('',0));throw error;}
 });
 attachMiniQueries(app,db,config.bindings);
 attachMiniMembers(app,db,config.bindings);
 attachMiniPlatforms(app,db,config.bindings);
 attachMiniRedemptions(app,db,config.bindings,vault);
 app.get('/me',async req=>{
  empty.parse(req.query);
  const p=await authenticateMini(db,req.headers.authorization,config.bindings,req.headers.origin);
  return {userId:p.userId,brandId:p.brandId,botId:p.botId,expiresAt:p.expiresAt};
 });
 app.post('/auth/logout',{bodyLimit:1024},async(req,reply)=>{
  empty.parse(req.query);empty.parse(req.body);
  const p=await authenticateMini(db,req.headers.authorization,config.bindings,req.headers.origin);
  const result=await logoutMini(db,p,req.id);
  reply.header('Set-Cookie',recoveryCookie('',0));return result;
 });
}
