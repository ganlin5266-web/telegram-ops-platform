import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import {z} from 'zod';
import {DomainError,type Database,type Queryable} from './db.js';
import {dummyPasswordHash,verifyPassword} from './passwords.js';
import {adminProfile,permissionGrants,accessibleBrands,accessibleBots} from './admin-directory.js';
export type BrowserAuthConfig={allowedOrigins:string[];secure:boolean;sameSite:'Lax'|'Strict'|'None';sessionSeconds:number;production?:boolean};
export function browserConfig(env:NodeJS.ProcessEnv):BrowserAuthConfig {
 const production=env.NODE_ENV==='production';
 const config:BrowserAuthConfig={allowedOrigins:(env.ADMIN_ALLOWED_ORIGINS??'http://localhost:5173').split(',').map(s=>s.trim()).filter(Boolean),secure:production||env.ADMIN_COOKIE_SECURE==='true',sameSite:(env.ADMIN_COOKIE_SAME_SITE??'Lax') as BrowserAuthConfig['sameSite'],sessionSeconds:Number(env.ADMIN_SESSION_SECONDS??28800),production};
 validateConfig(config);return config;
}
function validateConfig(c:BrowserAuthConfig) {
 if(!['Lax','Strict','None'].includes(c.sameSite)||!Number.isInteger(c.sessionSeconds)||c.sessionSeconds<60||c.sessionSeconds>86400||!c.allowedOrigins.length) throw new Error('Invalid browser authentication configuration');
 if((c.production||c.sameSite==='None')&&!c.secure) throw new Error('Secure cookie required');
 for(const origin of c.allowedOrigins) {const u=new URL(origin);if(u.origin!==origin||!['http:','https:'].includes(u.protocol)||u.username||u.password||origin.includes('*')||(c.production&&u.protocol!=='https:')) throw new Error('Exact HTTPS production origins required');}
}
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const csrf=(token:string)=>digest(`telegram-ops:csrf:${token}`);
function equal(a:string,b:string) {const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
const loginBody=z.object({login:z.string().trim().toLowerCase().min(3).max(120).regex(/^[a-z0-9@._+-]+$/),password:z.string().min(1).refine(s=>Buffer.byteLength(s)<=128)}).strict();
export async function securityAudit(tx:Queryable,action:string,adminId:string|null,request?:FastifyRequest,objectId='authentication') {
 await tx.query(`INSERT INTO audit_logs(admin_id,action,object_type,object_id,request_id,ip) VALUES($1,$2,'admin_auth',$3,$4,$5)`,[adminId,action,objectId,request?.id??null,request?.ip??null]);
}
export function attachBrowserAuth(app:FastifyInstance,db:Database,config:BrowserAuthConfig) {
 validateConfig(config);
 const cookieName=config.secure?'__Host-telegram_ops_session':'telegram_ops_session';
 type Session={adminId:string;id:string;expiresAt:string;csrfToken:string};
 const authenticated=new WeakMap<FastifyRequest,Session>();
 function cookie(request:FastifyRequest) {
  const matches=(request.headers.cookie??'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(`${cookieName}=`));
  if(matches.length!==1) return undefined;
  const value=matches[0]!.slice(cookieName.length+1);return /^[a-f0-9]{64}$/.test(value)?value:undefined;
 }
 function setCookie(reply:FastifyReply,token:string,maxAge:number) {
  reply.header('Set-Cookie',`${cookieName}=${token}; Path=/; HttpOnly; SameSite=${config.sameSite}; Max-Age=${maxAge}${config.secure?'; Secure':''}`);
 }
 async function revoke(tx:Queryable,token:string,reason:string,request:FastifyRequest) {
  const row=(await tx.query(`UPDATE admin_sessions SET revoked_at=now(),revoke_reason=$2 WHERE token_hash=$1 AND revoked_at IS NULL RETURNING id,admin_id`,[digest(token),reason])).rows[0];
  if(row) await securityAudit(tx,`auth.session_${reason}`,row.admin_id,request,row.id);
 }
 async function authenticate(request:FastifyRequest):Promise<Session> {
  const cached=authenticated.get(request);if(cached) return cached;
  const token=cookie(request);if(!token) throw new DomainError('unauthorized',401);
  const row=(await db.query(`SELECT s.id,s.admin_id,s.expires_at,s.revoked_at,a.status,(s.expires_at>now()) AS valid FROM admin_sessions s JOIN admins a ON a.id=s.admin_id WHERE s.token_hash=$1`,[digest(token)])).rows[0];
  if(!row||row.revoked_at) throw new DomainError('unauthorized',401);
  if(!row.valid||row.status!=='active') {
   await db.transaction(tx=>revoke(tx,token,row.valid?'revoked':'expired',request));
   throw new DomainError(row.valid?'unauthorized':'session_expired',401);
  }
  const session={adminId:row.admin_id,id:row.id,expiresAt:new Date(row.expires_at).toISOString(),csrfToken:csrf(token)};authenticated.set(request,session);return session;
 }
 app.addHook('onRequest',async(request,reply)=>{
  const path=request.url.split('?')[0]!;if(!path.startsWith('/v1/')) return;
  reply.header('Cache-Control','no-store').header('Vary','Origin').header('X-Content-Type-Options','nosniff');
  const origin=request.headers.origin;
  if(origin&&!config.allowedOrigins.includes(origin)) throw new DomainError('origin_not_allowed',403);
  if(origin) reply.header('Access-Control-Allow-Origin',origin).header('Access-Control-Allow-Credentials','true');
  if(request.method==='OPTIONS') {
   if(!origin||!['GET','POST'].includes(String(request.headers['access-control-request-method']))) throw new DomainError('cors_denied',403);
   const headers=String(request.headers['access-control-request-headers']??'').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean);
   if(headers.some(h=>!['content-type','x-csrf-token','x-csrf-protection','idempotency-key'].includes(h))) throw new DomainError('cors_denied',403);
   return reply.header('Access-Control-Allow-Methods','GET, POST').header('Access-Control-Allow-Headers','Content-Type, X-CSRF-Token, X-CSRF-Protection, Idempotency-Key').code(204).send();
  }
  if(!['GET','HEAD'].includes(request.method)) {
   if(!origin||!config.allowedOrigins.includes(origin)) throw new DomainError('origin_required',403);
   if(path==='/v1/auth/login') {
    if(request.headers['x-csrf-protection']!=='1'||!request.headers['content-type']?.startsWith('application/json')) throw new DomainError('csrf_failed',403);
   } else {
    const session=await authenticate(request);
    const supplied=request.headers['x-csrf-token'];
    if(typeof supplied!=='string'||!equal(supplied,session.csrfToken)) throw new DomainError('csrf_failed',403);
   }
  }
 });
 app.addHook('onResponse',async(request,reply)=>{
  const session=authenticated.get(request);
  if(session&&reply.statusCode===403) await db.transaction(tx=>securityAudit(tx,'auth.permission_denied',session.adminId,request));
 });
 app.post('/v1/auth/login',{bodyLimit:4096},async(request,reply)=>{
  const parsed=loginBody.safeParse(request.body);
  // Malformed, unknown, disabled and wrong-password attempts share the same error.
  const login=parsed.success?parsed.data.login:'invalid';
  const limited=await db.transaction(async tx=>{
   let blocked=false;
   for(const [key,max] of [[`ip:${request.ip}`,50],[`login:${login}`,10]] as const) {
    const row=(await tx.query(`INSERT INTO admin_login_limits(bucket_hash,attempts) VALUES($1,1)
     ON CONFLICT(bucket_hash) DO UPDATE SET attempts=CASE WHEN admin_login_limits.window_started_at<now()-interval '15 minutes' THEN 1 ELSE admin_login_limits.attempts+1 END,
     window_started_at=CASE WHEN admin_login_limits.window_started_at<now()-interval '15 minutes' THEN now() ELSE admin_login_limits.window_started_at END RETURNING attempts`,[digest(key)])).rows[0]!;
    if(row.attempts>max) blocked=true;
   }
   if(blocked) await securityAudit(tx,'auth.login_limited',null,request);
   return blocked;
  });
  if(limited) return reply.header('Retry-After','900').code(429).send({error:'login_rate_limited',requestId:request.id});
  const credential=(await db.query(`SELECT c.admin_id,c.password_hash,a.status FROM admin_credentials c JOIN admins a ON a.id=c.admin_id WHERE c.login=$1`,[login])).rows[0];
  const valid=await verifyPassword(parsed.success?parsed.data.password:'invalid',credential?.password_hash??dummyPasswordHash);
  if(!parsed.success||!credential||!valid||credential.status!=='active') {
   await db.transaction(tx=>securityAudit(tx,'auth.login_failed',null,request));throw new DomainError('invalid_credentials',401);
  }
  const token=randomBytes(32).toString('hex');
  const session=await db.transaction(async tx=>{
   // Recheck after password work, so disabling an account cannot race a login.
   const active=(await tx.query("SELECT id FROM admins WHERE id=$1 AND status='active' FOR SHARE",[credential.admin_id])).rows[0];
   if(!active) throw new DomainError('invalid_credentials',401);
   const old=cookie(request);if(old) await revoke(tx,old,'rotated',request);
   const row=(await tx.query(`INSERT INTO admin_sessions(admin_id,token_hash,expires_at) VALUES($1,$2,now()+$3::int*interval '1 second') RETURNING id,expires_at`,[credential.admin_id,digest(token),config.sessionSeconds])).rows[0]!;
   await securityAudit(tx,'auth.login_success',credential.admin_id,request,row.id);return row;
  });
  setCookie(reply,token,config.sessionSeconds);
  return {csrfToken:csrf(token),expiresAt:new Date(session.expires_at).toISOString()};
 });
 app.post('/v1/auth/logout',async(request,reply)=>{
  const session=await authenticate(request);
  await db.transaction(async tx=>{await revoke(tx,cookie(request)!,'revoked',request);await securityAudit(tx,'auth.logout',session.adminId,request,session.id);});
  setCookie(reply,'',0);return reply.code(204).send();
 });
 app.get('/v1/me',async request=>{
  const session=await authenticate(request);
  return {...await adminProfile(db,session.adminId),grants:await permissionGrants(db,session.adminId),csrfToken:session.csrfToken,expiresAt:session.expiresAt};
 });
 app.get('/v1/me/permissions',async request=>{
  const session=await authenticate(request);
  const query=z.object({brandId:z.uuid().optional(),botId:z.uuid().optional()}).refine(q=>!!q.brandId===!!q.botId).parse(request.query);
  const grants=await permissionGrants(db,session.adminId);
  if(!query.brandId) return {grants};
  if(!(await accessibleBots(db,session.adminId,query.brandId)).some(b=>b.botId===query.botId)) throw new DomainError('forbidden',403);
  const permissions=[...new Set(grants.filter(g=>g.brandId===null||(g.brandId===query.brandId&&(g.botId===null||g.botId===query.botId))).flatMap(g=>g.permissions as string[]))].sort();
  return {brandId:query.brandId,botId:query.botId,permissions};
 });
 app.get('/v1/me/brands',async request=>({items:await accessibleBrands(db,(await authenticate(request)).adminId)}));
 app.get('/v1/me/brands/:brandId/bots',async request=>{
  const {brandId}=z.object({brandId:z.uuid()}).parse(request.params);
  return {items:await accessibleBots(db,(await authenticate(request)).adminId,brandId)};
 });
 return authenticate;
}
