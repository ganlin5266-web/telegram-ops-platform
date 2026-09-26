import {recoverMini,recoveryCookie,readRecoveryCookie,requireRecoveryProtection} from './mini-recovery.js';
import {verifyInitData} from './telegram-init-data.js';
import {attachMiniQueries} from './mini-queries.js';
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
const exchangeBody=z.object({appKey:z.string().max(64),initData:z.string().min(1).max(16384),recovery:z.boolean().optional()}).strict();
const empty=z.object({}).strict();
export function attachMiniAuth(app:FastifyInstance,db:Database,secrets:SecretProvider,config:MiniConfig) {
 validateMiniConfig(config);
 app.addHook('onRequest',async(req,reply)=>{
  reply.header('Cache-Control','no-store').header('Vary','Origin').header('X-Content-Type-Options','nosniff');
  const origin=req.headers.origin;
  if(origin&&!config.bindings.some(b=>b.origin===origin)) throw new DomainError('mini_origin_not_allowed',403);
  if(origin) reply.header('Access-Control-Allow-Origin',origin);
  if(req.method==='OPTIONS') {
   const method=String(req.headers['access-control-request-method']);
   const headers=String(req.headers['access-control-request-headers']??'').toLowerCase().split(',').map(s=>s.trim()).filter(Boolean);
   if(!origin||!['GET','POST'].includes(method)||headers.some(h=>!['content-type','authorization','x-mini-csrf'].includes(h))) throw new DomainError('mini_cors_denied',403);
   return reply.header('Access-Control-Allow-Methods','GET, POST').header('Access-Control-Allow-Headers','Content-Type, Authorization, X-Mini-CSRF').code(204).send();
  }
  if(!['GET','HEAD'].includes(req.method)) {
   if(!origin) throw new DomainError('mini_origin_required',403);
   if(req.headers['content-type']?.split(';')[0]?.trim().toLowerCase()!=='application/json') throw new DomainError('mini_json_required',415);
  }
 });
 // Explicit preflight routes: no catch-all business API or administrator exemption.
 for(const url of ['/auth/exchange','/me','/auth/logout','/auth/recover']) app.options(url,async()=>({}));
 app.post('/auth/exchange',{bodyLimit:20000},async(req,reply)=>{
  empty.parse(req.query);const body=exchangeBody.parse(req.body);
  const binding=config.bindings.find(b=>b.appKey===body.appKey);
  if(!binding) {await miniRateLimit(db,`invalid:unknown:${req.ip}`,50);throw miniUnauthorized();}
  if(req.headers.origin!==binding.origin) throw new DomainError('mini_origin_not_allowed',403);
  const secret=secrets(binding.tokenSecretRef);if(!secret) throw miniUnauthorized();
  try {verifyInitData(body.initData,secret);} catch(error) {
   await miniRateLimit(db,`invalid:${binding.botId}:${req.ip}`,50);throw error;
  }
  if(body.recovery) requireRecoveryProtection(req.headers);
  const session=await exchangeMiniSession(db,binding,body.initData,secret,req.id);
  if(body.recovery) reply.header('Set-Cookie',recoveryCookie(session.token));
  return reply.send(session);
 });
 app.post('/auth/recover',{bodyLimit:20000},async(req,reply)=>{
  empty.parse(req.query);requireRecoveryProtection(req.headers);
  const body=exchangeBody.omit({recovery:true}).parse(req.body);
  const binding=config.bindings.find(b=>b.appKey===body.appKey);
  if(!binding||req.headers.origin!==binding.origin) throw miniUnauthorized();
  const secret=secrets(binding.tokenSecretRef);if(!secret) throw miniUnauthorized();
  try {return await recoverMini(db,readRecoveryCookie(req.headers.cookie),binding,body.initData,secret,binding.origin,req.id);}
  catch(error) {reply.header('Set-Cookie',recoveryCookie('',0));throw error;}
 });
 attachMiniQueries(app,db,config.bindings);
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
