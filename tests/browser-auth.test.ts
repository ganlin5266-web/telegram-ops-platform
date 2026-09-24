import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import type {FastifyInstance} from 'fastify';
import {postgres,one,DomainError,type Database,type Queryable} from '../src/db.js';
import {migrate} from '../src/migrations.js';
import {createApp} from '../src/app.js';
import {hashPassword,verifyPassword} from '../src/passwords.js';
import {browserConfig,type BrowserAuthConfig} from '../src/browser-auth.js';
import {bootstrapFirstAdmin} from '../src/admin-bootstrap.js';
import {readFile} from 'node:fs/promises';
const password=`${randomUUID()}${randomUUID()}`;
const config:BrowserAuthConfig={allowedOrigins:['https://admin.example.test'],secure:true,sameSite:'Lax',sessionSeconds:28800,production:true};
let db:Database,close:()=>Promise<void>,passwordHash:string;
const apps:FastifyInstance[]=[];
function memoryDB() {
 const pg=new PGlite();const adapt=(client:any):Queryable=>({query:async(sql,params)=>params===undefined?(await client.exec(sql)).at(-1)??{rows:[]}:client.query(sql,params)});
 return {db:{...adapt(pg),transaction:<T>(fn:(tx:Queryable)=>Promise<T>)=>pg.transaction(tx=>fn(adapt(tx)))} as Database,close:()=>pg.close()};
}
before(async()=>{
 if(process.env.TEST_DATABASE_URL) {const pg=postgres(process.env.TEST_DATABASE_URL);db=pg;close=pg.close;}
 else {const memory=memoryDB();db=memory.db;close=memory.close;}
 await migrate(db);passwordHash=await hashPassword(password);
});
after(async()=>{await Promise.all(apps.map(app=>app.close()));await close();});
let fixtureNumber=0;
async function fixture(role='Viewer',scope:'bot'|'brand'|'global'='bot',runtime=false) {
 const brand=await one(db,"INSERT INTO brands(name,slug,default_language) VALUES('A',$1,'pt-BR') RETURNING id",[randomUUID()]);
 const otherBrand=await one(db,"INSERT INTO brands(name,slug,default_language) VALUES('B',$1,'en') RETURNING id",[randomUUID()]);
 async function bot(brandId:string) {return one(db,`INSERT INTO telegram_bots(brand_id,name,username,token_secret_ref,webhook_secret_ref,default_language,supported_languages,status)
 VALUES($1,'Test',$2,$3,$4,'pt-BR',ARRAY['pt-BR','en'],'active') RETURNING id`,[brandId,randomUUID(),randomUUID(),randomUUID()]);}
 const a1=await bot(brand.id),a2=await bot(brand.id),b1=await bot(otherBrand.id);
 const admin=await one(db,"INSERT INTO admins(auth_subject,display_name,ui_language) VALUES($1,'Session administrator','zh-CN') RETURNING id",[randomUUID()]);
 const login=`admin-${randomUUID()}`;
 await db.query('INSERT INTO admin_credentials(admin_id,login,password_hash) VALUES($1,$2,$3)',[admin.id,login,passwordHash]);
 await db.query('INSERT INTO admin_roles(admin_id,role_id,brand_id,bot_id) SELECT $1,id,$2,$3 FROM roles WHERE name=$4',[admin.id,scope==='global'?null:brand.id,scope==='bot'?a1.id:null,role]);
 const users=[];
 for(const [brandId,botId] of [[brand.id,a1.id],[brand.id,a2.id],[otherBrand.id,b1.id]]) users.push(await one(db,'INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id) VALUES($1,$2,444) RETURNING id',[brandId,botId]));
 let connection=db;
 if(runtime) {
  await db.query("DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='telegram_app') THEN CREATE ROLE telegram_app NOLOGIN; END IF; END $$;");
  await db.query(await readFile('db/runtime-grants.sql','utf8'));
  connection={query:(sql,params)=>db.transaction(async tx=>{await tx.query('SET LOCAL ROLE telegram_app');return tx.query(sql,params);}),transaction:fn=>db.transaction(async tx=>{await tx.query('SET LOCAL ROLE telegram_app');return fn(tx);})};
 }
 const app=createApp(connection,()=>undefined,async()=>{throw new DomainError('unauthorized',401);},config);apps.push(app);
 const remoteAddress=`192.0.2.${++fixtureNumber}`;
 const headers={origin:config.allowedOrigins[0]!,'x-csrf-protection':'1'};
 const signIn=(loginValue=login,passwordValue=password,existingCookie?:string)=>app.inject({method:'POST',url:'/v1/auth/login',remoteAddress,headers:{...headers,...(existingCookie?{cookie:existingCookie}:{})},payload:{login:loginValue,password:passwordValue}});
 const base=`/v1/brands/${brand.id}/bots/${a1.id}`;
 const get=(url:string,cookie?:string)=>app.inject({url,remoteAddress,headers:{...headers,...(cookie?{cookie}:{})}});
 return {app,admin,login,brand,otherBrand,a1,a2,b1,users,signIn,get,base,headers,remoteAddress};
}
function cookieOf(response:{headers:Record<string,any>}) {return String(response.headers['set-cookie']).split(';')[0]!;}
async function session(f:Awaited<ReturnType<typeof fixture>>) {const res=await f.signIn();assert.equal(res.statusCode,200,res.body);return {cookie:cookieOf(res),csrfToken:res.json().csrfToken};}
function adjust(f:Awaited<ReturnType<typeof fixture>>,s:{cookie:string;csrfToken:string},base=f.base,userId=f.users[0]!.id) {
 return f.app.inject({method:'POST',url:`${base}/points/adjustments`,remoteAddress:f.remoteAddress,headers:{...f.headers,cookie:s.cookie,'x-csrf-token':s.csrfToken,'idempotency-key':randomUUID()},payload:{userId,delta:'5',eventId:randomUUID(),note:'Session test'}});
}
test('browser: password hashes are salted scrypt records and enforce password policy',async()=>{
 assert.notEqual(await hashPassword(password),passwordHash);assert.ok(await verifyPassword(password,passwordHash));assert.equal(await verifyPassword('incorrect',passwordHash),false);
 await assert.rejects(()=>hashPassword('weak'),/password_policy/);assert.ok(!passwordHash.includes(password));
});
test('browser: valid credentials issue protected cookie, opaque session stored hashed',async()=>{
 const f=await fixture();const response=await f.signIn();assert.equal(response.statusCode,200);
 const header=String(response.headers['set-cookie']);for(const flag of ['__Host-','HttpOnly','Secure','SameSite=Lax','Path=/','Max-Age=28800']) assert.ok(header.includes(flag));assert.ok(!header.includes('Domain='));
 const token=cookieOf(response).split('=')[1]!;const row=await one(db,'SELECT token_hash FROM admin_sessions WHERE admin_id=$1',[f.admin.id]);
 assert.equal(row.token_hash,createHash('sha256').update(token).digest('hex'));assert.notEqual(row.token_hash,token);assert.equal(response.headers['cache-control'],'no-store');
});
test('browser: wrong password, unknown login and disabled admin return the same generic error',async()=>{
 const f=await fixture();const wrong=await f.signIn(f.login,'wrong');const unknown=await f.signIn(`missing-${randomUUID()}`,'wrong');
 await db.query("UPDATE admins SET status='disabled' WHERE id=$1",[f.admin.id]);const disabled=await f.signIn();
 for(const response of [wrong,unknown,disabled]) {assert.equal(response.statusCode,401);assert.equal(response.json().error,'invalid_credentials');assert.equal(response.headers['set-cookie'],undefined);}
});
test('browser: anonymous and fixed bearer callers cannot access me or existing user APIs',async()=>{
 const f=await fixture();for(const url of ['/v1/me','/v1/me/permissions','/v1/me/brands',`${f.base}/users`,`${f.base}/users/${f.users[0]!.id}/points`]) assert.equal((await f.get(url)).statusCode,401);
 assert.equal((await f.app.inject({url:'/v1/me',headers:{authorization:`Bearer ${randomUUID()}`}})).statusCode,401);
});
test('browser: me returns real identity, zh-CN and scoped grants; effective permissions match DB',async()=>{
 const f=await fixture();const s=await session(f);const me=(await f.get('/v1/me',s.cookie)).json();assert.equal(me.id,f.admin.id);assert.equal(me.uiLanguage,'zh-CN');assert.equal(me.grants[0].role,'Viewer');assert.deepEqual(me.grants[0].permissions,['users.read']);
 const effective=await f.get(`/v1/me/permissions?brandId=${f.brand.id}&botId=${f.a1.id}`,s.cookie);assert.deepEqual(effective.json().permissions,['users.read']);
 assert.equal((await f.get(`/v1/me/permissions?brandId=${f.brand.id}&botId=${f.a2.id}`,s.cookie)).statusCode,403);
});
test('browser: logout revokes session server-side and emits login/logout audit',async()=>{
 const f=await fixture();const s=await session(f);
 const response=await f.app.inject({method:'POST',url:'/v1/auth/logout',headers:{...f.headers,cookie:s.cookie,'x-csrf-token':s.csrfToken}});assert.equal(response.statusCode,204);assert.match(String(response.headers['set-cookie']),/Max-Age=0/);
 assert.equal((await f.get('/v1/me',s.cookie)).statusCode,401);
 const events=(await db.query('SELECT action FROM audit_logs WHERE admin_id=$1',[f.admin.id])).rows.map(r=>r.action);for(const action of ['auth.login_success','auth.logout','auth.session_revoked']) assert.ok(events.includes(action));
});
test('browser: expired session is rejected and invalidation is audited once',async()=>{
 const f=await fixture();const s=await session(f);await db.query("UPDATE admin_sessions SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE admin_id=$1",[f.admin.id]);
 const response=await f.get('/v1/me',s.cookie);assert.equal(response.statusCode,401);assert.equal(response.json().error,'session_expired');await f.get('/v1/me',s.cookie);
 assert.equal((await db.query("SELECT id FROM audit_logs WHERE admin_id=$1 AND action='auth.session_expired'",[f.admin.id])).rows.length,1);
});
test('browser: repeat login rotates session and never reuses a supplied session ID',async()=>{
 const f=await fixture();const s=await session(f);const response=await f.signIn(f.login,password,s.cookie);const replacement=cookieOf(response);assert.notEqual(replacement,s.cookie);
 assert.equal((await f.get('/v1/me',s.cookie)).statusCode,401);assert.equal((await f.get('/v1/me',replacement)).statusCode,200);
});
test('browser: Viewer reads scoped users and points, cannot adjust',async()=>{
 const f=await fixture('Viewer'),s=await session(f);assert.equal((await f.get(`${f.base}/users`,s.cookie)).statusCode,200);
 const points=await f.get(`${f.base}/users/${f.users[0]!.id}/points`,s.cookie);assert.equal(points.json().balance,'0');assert.equal((await adjust(f,s)).statusCode,403);
});
test('browser: Operator gets existing permissions and cannot adjust points',async()=>{
 const f=await fixture('Operator'),s=await session(f);const result=(await f.get(`/v1/me/permissions?brandId=${f.brand.id}&botId=${f.a1.id}`,s.cookie)).json();assert.deepEqual(result.permissions,['activities.manage','messages.publish','users.read']);assert.equal((await adjust(f,s)).statusCode,403);
});
test('browser: brand Admin sees sibling bots and can adjust within brand only',async()=>{
 const f=await fixture('Admin','brand'),s=await session(f);const bots=(await f.get(`/v1/me/brands/${f.brand.id}/bots`,s.cookie)).json().items;
 assert.equal(bots.length,2);assert.equal((await adjust(f,s)).statusCode,200);assert.equal((await f.get(`/v1/me/brands/${f.otherBrand.id}/bots`,s.cookie)).statusCode,403);
});
test('browser: global Super Admin sees and reads all authorized brands and bots',async()=>{
 const f=await fixture('Super Admin','global'),s=await session(f);const brands=(await f.get('/v1/me/brands',s.cookie)).json().items;assert.ok(brands.some((b:any)=>b.brandId===f.brand.id));assert.ok(brands.some((b:any)=>b.brandId===f.otherBrand.id));
 const base=`/v1/brands/${f.otherBrand.id}/bots/${f.b1.id}`;assert.equal((await adjust(f,s,base,f.users[2]!.id)).statusCode,200);
});
test('browser: bot-scoped grants expose only authorized brand and bot; URLs cannot elevate access',async()=>{
 const f=await fixture(),s=await session(f);assert.deepEqual((await f.get('/v1/me/brands',s.cookie)).json().items.map((b:any)=>b.brandId),[f.brand.id]);
 assert.deepEqual((await f.get(`/v1/me/brands/${f.brand.id}/bots`,s.cookie)).json().items.map((b:any)=>b.botId),[f.a1.id]);
 for(const [brandId,botId] of [[f.brand.id,f.a2.id],[f.otherBrand.id,f.b1.id]]) assert.equal((await f.get(`/v1/brands/${brandId}/bots/${botId}/users`,s.cookie)).statusCode,403);
 assert.equal((await f.get(`/v1/me/brands/${f.otherBrand.id}/bots`,s.cookie)).statusCode,403);
});
test('browser: foreign user and point account cannot be read under an allowed bot URL',async()=>{
 const f=await fixture(),s=await session(f);const listing=(await f.get(`${f.base}/users`,s.cookie)).json();assert.equal(listing.items.length,1);assert.equal(listing.items[0].id,f.users[0]!.id);
 for(const user of f.users.slice(1)) {assert.equal((await f.get(`${f.base}/users/${user.id}/points`,s.cookie)).statusCode,404);assert.equal((await f.get(`${f.base}/users/${user.id}/templates/WELCOME`,s.cookie)).statusCode,404);}
});
test('browser: unknown origins cannot read credentialed responses or pass preflight',async()=>{
 const f=await fixture(),s=await session(f);
 for(const method of ['GET','OPTIONS'] as const) {const response=await f.app.inject({method,url:'/v1/me',headers:{origin:'https://evil.example.test',cookie:s.cookie,'access-control-request-method':'GET'}});assert.equal(response.statusCode,403);assert.equal(response.headers['access-control-allow-origin'],undefined);assert.equal(response.headers['access-control-allow-credentials'],undefined);}
 const response=await f.app.inject({method:'OPTIONS',url:'/v1/auth/login',headers:{origin:config.allowedOrigins[0]!,'access-control-request-method':'POST','access-control-request-headers':'content-type,x-csrf-protection'}});assert.equal(response.statusCode,204);assert.equal(response.headers['access-control-allow-origin'],config.allowedOrigins[0]);assert.equal(response.headers['access-control-allow-credentials'],'true');
});
test('browser: CSRF token and trusted Origin are mandatory for authenticated mutations',async()=>{
 const f=await fixture('Admin'),s=await session(f);
 for(const headers of [{cookie:s.cookie,origin:config.allowedOrigins[0]!},{cookie:s.cookie,origin:config.allowedOrigins[0]!,'x-csrf-token':'wrong'},{cookie:s.cookie,'x-csrf-token':s.csrfToken}]) {
  const response=await f.app.inject({method:'POST',url:'/v1/auth/logout',headers});assert.equal(response.statusCode,403);
 }
 assert.equal((await f.get('/v1/me',s.cookie)).statusCode,200);assert.equal((await adjust(f,s)).statusCode,200);
});
test('browser: login CSRF rejects missing custom header and form submissions',async()=>{
 const f=await fixture();const response=await f.app.inject({method:'POST',url:'/v1/auth/login',headers:{origin:config.allowedOrigins[0]!},payload:{login:f.login,password}});assert.equal(response.statusCode,403);
 const form=await f.app.inject({method:'POST',url:'/v1/auth/login',headers:{...f.headers,'content-type':'application/x-www-form-urlencoded'},payload:'login=x&password=y'});assert.equal(form.statusCode,403);
});
test('browser: login limit is persistent across app instances and unknown accounts',async()=>{
 const f=await fixture();const missing=`missing-${randomUUID()}`;for(let i=0;i<10;i++) assert.equal((await f.signIn(missing,'wrong')).statusCode,401);
 const other=createApp(db,()=>undefined,async()=>{throw new Error('unused');},config);apps.push(other);
 const response=await other.inject({method:'POST',url:'/v1/auth/login',remoteAddress:'198.51.100.9',headers:f.headers,payload:{login:missing,password:'wrong'}});assert.equal(response.statusCode,429);assert.equal(response.headers['retry-after'],'900');
});
test('browser: zh-CN administrator session does not change Telegram template language',async()=>{
 const f=await fixture(),s=await session(f);await db.query("UPDATE telegram_users SET telegram_language_code='zh-CN' WHERE id=$1",[f.users[0]!.id]);
 await db.query("INSERT INTO message_templates(brand_id,bot_id,template_key,language,body) VALUES($1,$2,'WELCOME','pt-BR','Olá')",[f.brand.id,f.a1.id]);
 assert.equal((await f.get('/v1/me',s.cookie)).json().uiLanguage,'zh-CN');const preview=await f.get(`${f.base}/users/${f.users[0]!.id}/templates/WELCOME`,s.cookie);assert.equal(preview.json().language,'pt-BR');
});
test('browser: response DTOs and auth audit contain no credential hashes or session tokens',async()=>{
 const f=await fixture(),s=await session(f);const row=await one(db,'SELECT token_hash FROM admin_sessions WHERE admin_id=$1',[f.admin.id]);
 for(const url of ['/v1/me','/v1/me/permissions','/v1/me/brands',`/v1/me/brands/${f.brand.id}/bots`]) {
  const body=(await f.get(url,s.cookie)).body;for(const forbidden of ['password_hash','token_secret_ref','webhook_secret_ref',passwordHash,password,row.token_hash,s.cookie.split('=')[1]!]) assert.ok(!body.includes(forbidden));
 }
 const audit=JSON.stringify((await db.query('SELECT * FROM audit_logs WHERE admin_id=$1',[f.admin.id])).rows);for(const secret of [password,passwordHash,row.token_hash,s.cookie.split('=')[1]!,s.csrfToken]) assert.ok(!audit.includes(secret));
});
test('browser: permission changes and administrator disable take effect without new login',async()=>{
 const f=await fixture(),s=await session(f);await db.query('DELETE FROM admin_roles WHERE admin_id=$1',[f.admin.id]);assert.equal((await f.get(`${f.base}/users`,s.cookie)).statusCode,403);assert.deepEqual((await f.get('/v1/me/brands',s.cookie)).json().items,[]);
 await db.query("UPDATE admins SET status='disabled' WHERE id=$1",[f.admin.id]);assert.equal((await f.get('/v1/me',s.cookie)).statusCode,401);
});
test('browser: permission denial and failed login are audited without attempted passwords',async()=>{
 const f=await fixture(),s=await session(f);await adjust(f,s);await f.signIn(f.login,'wrong');
 assert.equal((await db.query("SELECT id FROM audit_logs WHERE admin_id=$1 AND action='auth.permission_denied'",[f.admin.id])).rows.length,1);
 assert.ok((await db.query("SELECT id FROM audit_logs WHERE action='auth.login_failed'")).rows.length>0);
});
test('browser: production and cross-site configuration fail closed unless cookies are Secure',async()=>{
 assert.throws(()=>browserConfig({NODE_ENV:'production',ADMIN_ALLOWED_ORIGINS:'http://localhost:5173'}));assert.throws(()=>browserConfig({ADMIN_ALLOWED_ORIGINS:'*'}));assert.throws(()=>browserConfig({ADMIN_COOKIE_SAME_SITE:'None'}));
 const cfg=browserConfig({NODE_ENV:'production',ADMIN_ALLOWED_ORIGINS:'https://admin.example.test',ADMIN_COOKIE_SAME_SITE:'None'});assert.equal(cfg.secure,true);assert.equal(cfg.sameSite,'None');
 const app=createApp(db,()=>undefined,async()=>{throw new Error('unused');},cfg);apps.push(app);
});
test('browser: restricted runtime role can authenticate, discover scopes and read existing APIs',async()=>{
 const f=await fixture('Viewer','bot',true),s=await session(f);assert.equal((await f.get('/v1/me',s.cookie)).statusCode,200);assert.equal((await f.get('/v1/me/brands',s.cookie)).statusCode,200);assert.equal((await f.get(`${f.base}/users`,s.cookie)).statusCode,200);
});
test('browser: first-admin bootstrap succeeds once with hashed password and global grant',async()=>{
 let isolated:Database,finish:()=>Promise<void>;
 if(process.env.TEST_DATABASE_URL) {
  const name=`bootstrap_${randomUUID().replaceAll('-','')}`;await db.query(`CREATE DATABASE "${name}"`);const url=new URL(process.env.TEST_DATABASE_URL);url.pathname=`/${name}`;const pg=postgres(url.toString());isolated=pg;finish=async()=>{await pg.close();await db.query(`DROP DATABASE "${name}"`);};
 } else {const memory=memoryDB();isolated=memory.db;finish=memory.close;}
 try {
  await migrate(isolated);const input={login:`first-${randomUUID()}`,displayName:'First admin',password};
  const result=await bootstrapFirstAdmin(isolated,input);assert.ok(result.adminId);
  const account=await one(isolated,'SELECT * FROM admin_credentials WHERE admin_id=$1',[result.adminId]);assert.ok(await verifyPassword(password,account.password_hash));
  const grant=await one(isolated,"SELECT r.name,ar.brand_id,ar.bot_id FROM admin_roles ar JOIN roles r ON r.id=ar.role_id WHERE ar.admin_id=$1",[result.adminId]);assert.equal(grant.name,'Super Admin');assert.equal(grant.brand_id,null);assert.equal(grant.bot_id,null);
  await assert.rejects(()=>bootstrapFirstAdmin(isolated,input),/bootstrap_already_completed/);
 } finally {await finish();}
});

test('browser: cross-site SameSite=None issues only Secure host-scoped cookies',async()=>{
 const f=await fixture();const app=createApp(db,()=>undefined,async()=>{throw new Error('unused');},{...config,sameSite:'None'});apps.push(app);
 const response=await app.inject({method:'POST',url:'/v1/auth/login',remoteAddress:f.remoteAddress,headers:f.headers,payload:{login:f.login,password}});
 assert.equal(response.statusCode,200);const header=String(response.headers['set-cookie']);assert.match(header,/SameSite=None/);assert.match(header,/; Secure/);assert.match(header,/^__Host-/);
});
test('browser: malformed, forged and duplicate session cookies cannot authenticate',async()=>{
 const f=await fixture(),s=await session(f);
 for(const cookie of ['__Host-telegram_ops_session=bad',`__Host-telegram_ops_session=${'a'.repeat(64)}`,`${s.cookie}; ${s.cookie}`]) assert.equal((await f.get('/v1/me',cookie)).statusCode,401);
});
test('browser: IP rate limit cannot be bypassed with a forwarded IP header',async()=>{
 const f=await fixture();const bucket=createHash('sha256').update(`ip:${f.remoteAddress}`).digest('hex');
 await db.query('INSERT INTO admin_login_limits(bucket_hash,attempts) VALUES($1,50)',[bucket]);
 const response=await f.app.inject({method:'POST',url:'/v1/auth/login',remoteAddress:f.remoteAddress,headers:{...f.headers,'x-forwarded-for':'203.0.113.10'},payload:{login:f.login,password}});assert.equal(response.statusCode,429);
 assert.equal((await db.query('SELECT id FROM admin_sessions WHERE admin_id=$1',[f.admin.id])).rows.length,0);
});
