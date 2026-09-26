import Fastify, {LogController} from 'fastify';
import {z} from 'zod';
import {DomainError,one,scopeParams,type Database} from './db.js';
import {handleUpdate,type SecretProvider} from './telegram.js';
import {authorize,type Authenticator} from './auth.js';
import {postPoints} from './points.js';
import {getTemplate} from './language.js';
import {attachBrowserAuth,type BrowserAuthConfig} from './browser-auth.js';
import {attachDashboard} from './dashboard.js';
import {attachOperationsQueries} from './operations-queries.js';
import {attachMiniAuth,validateMiniConfig,type MiniConfig} from './mini-auth.js';
import type {FastifyRequest} from 'fastify';
const scopeSchema=z.object({brandId:z.uuid(),botId:z.uuid()});
export function createApp(db:Database,secrets:SecretProvider,authenticate:Authenticator,browserAuth?:BrowserAuthConfig,miniAuth?:MiniConfig) {
 if(miniAuth) validateMiniConfig(miniAuth);
 const app=Fastify({bodyLimit:262144,logger:{redact:['req.headers.authorization','req.headers.x-telegram-bot-api-secret-token','req.headers.cookie','req.headers.x-csrf-token','res.headers.set-cookie']},logController:new LogController({disableRequestLogging:true})});
 app.setErrorHandler((err,request,reply)=>{
  if(err instanceof z.ZodError) return reply.code(400).send({error:'invalid_request',requestId:request.id});
  if(err instanceof DomainError) return reply.code(err.status).send({error:err.code,requestId:request.id});
  const status=(err as {statusCode?:number}).statusCode;
  if(status&&status>=400&&status<500) return reply.code(status).send({error:'invalid_request',requestId:request.id});
  // Never log DB detail, request body or upstream URLs: those may contain secrets/PII.
  request.log.error({requestId:request.id,code:(err as {code?:string}).code??'internal'},'request_failed');
  return reply.code(500).send({error:'internal_error',requestId:request.id});
 });
 app.get('/health',async()=>({status:'ok'}));
 app.get('/ready',async()=>{await db.query('SELECT 1');return {status:'ready'};});
 app.post('/webhooks/telegram/:botId',async request=>{
  const {botId}=z.object({botId:z.uuid()}).parse(request.params);
  const header=request.headers['x-telegram-bot-api-secret-token'];
  return handleUpdate(db,botId,typeof header==='string'?header:undefined,request.body,secrets);
 });
 if(miniAuth) app.register(async mini=>attachMiniAuth(mini,db,secrets,miniAuth),{prefix:'/v1/mini'});
 // Encapsulation keeps every existing admin route and hook in the same boundary.
 app.register(async app=>{
 const sessionAuthenticate=browserAuth?attachBrowserAuth(app,db,browserAuth):undefined;
 const authenticateRequest=(request:FastifyRequest)=>sessionAuthenticate?sessionAuthenticate(request):authenticate(request.headers.authorization);
 // Preflight must resolve inside this scope rather than the root 404 handler.
 if(browserAuth) app.options('/v1/*',async()=>({}));
 const base='/v1/brands/:brandId/bots/:botId';
 attachOperationsQueries(app,db,authenticateRequest);
 attachDashboard(app,db,authenticateRequest);
 app.get(`${base}/users/:userId/points`,async request=>{
  const s=scopeSchema.extend({userId:z.uuid()}).parse(request.params),p=await authenticateRequest(request);
  return db.transaction(async tx=>{await authorize(tx,p,s,'users.read');await one(tx,'SELECT id FROM telegram_users WHERE brand_id=$1 AND bot_id=$2 AND id=$3',[...scopeParams(s),s.userId]);
   const row=(await tx.query('SELECT balance::text FROM point_accounts WHERE brand_id=$1 AND bot_id=$2 AND user_id=$3',[...scopeParams(s),s.userId])).rows[0];return {balance:row?.balance??'0'};});
 });
 app.post(`${base}/points/adjustments`,async request=>{
  const s=scopeSchema.parse(request.params),p=await authenticateRequest(request);
  const body=z.object({userId:z.uuid(),delta:z.string().regex(/^-?[1-9]\d*$/).max(20),eventId:z.uuid(),note:z.string().min(1).max(500)}).strict().parse(request.body);
  const key=z.string().min(8).max(160).parse(request.headers['idempotency-key']);
  return db.transaction(async tx=>{await authorize(tx,p,s,'points.adjust');
   const ledger=await postPoints(tx,{...s,...body,source:'admin',businessType:'manual_adjustment',businessId:body.eventId,idempotencyKey:key});
   if(!(await tx.query(`SELECT id FROM audit_logs WHERE bot_id=$1 AND action='points.adjust' AND object_id=$2`,[s.botId,ledger.id])).rows.length)
    await tx.query(`INSERT INTO audit_logs(admin_id,brand_id,bot_id,action,object_type,object_id,before_data,after_data,request_id,ip,note) VALUES($1,$2,$3,'points.adjust','point_ledger',$4,$5,$6,$7,$8,$9)`,[p.adminId,...scopeParams(s),ledger.id,JSON.stringify({balance:String(ledger.balance_before)}),JSON.stringify({balance:String(ledger.balance_after),delta:String(ledger.delta)}),request.id,request.ip,body.note]);
   return {ledgerId:ledger.id,balance:String(ledger.balance_after)};});
 });
 app.get(`${base}/users/:userId/templates/:key`,async request=>{
  const s=scopeSchema.extend({userId:z.uuid(),key:z.string().regex(/^[A-Z_]{1,64}$/)}).parse(request.params),p=await authenticateRequest(request);
  return db.transaction(async tx=>{await authorize(tx,p,s,'users.read');return getTemplate(tx,s,s.userId,s.key);});
 });
 });
 return app;
}
