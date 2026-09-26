import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomBytes,randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import type {FastifyInstance} from 'fastify';
import {readFile} from 'node:fs/promises';
import {postgres,one,DomainError,type Database,type Queryable} from '../src/db.js';
import {migrate} from '../src/migrations.js';
import {createApp} from '../src/app.js';
import {hashPassword} from '../src/passwords.js';
import {miniDigest,exchangeMiniSession,miniRateLimit} from '../src/mini-sessions.js';
import {handleUpdate} from '../src/telegram.js';
let db:Database,close:()=>Promise<void>;const apps:FastifyInstance[]=[];
const adminOrigin='https://admin.example.test',origin='https://mini.example.test';
const adminConfig={allowedOrigins:[adminOrigin],secure:true,sameSite:'Lax' as const,sessionSeconds:28800,production:true};
function adapt(client:any):Queryable {return {query:async(sql,params)=>params===undefined?(await client.exec(sql)).at(-1)??{rows:[]}:client.query(sql,params)};}
before(async()=>{
 if(process.env.TEST_DATABASE_URL) {const pg=postgres(process.env.TEST_DATABASE_URL);db=pg;close=pg.close;}
 else {const pg=new PGlite();db={...adapt(pg),transaction:fn=>pg.transaction(tx=>fn(adapt(tx)))};close=()=>pg.close();}
 await migrate(db);
});
after(async()=>{await Promise.all(apps.map(app=>app.close()));await close();});
let counter=0;
async function fixture(runtime=false) {
 const brand=await one(db,"INSERT INTO brands(name,slug,default_language) VALUES('Mini synthetic',$1,'en') RETURNING id",[randomUUID()]);
 const ref=`MINI_TEST_${randomUUID().replaceAll('-','').toUpperCase()}`;
 const bot=await one(db,`INSERT INTO telegram_bots(brand_id,name,username,token_secret_ref,webhook_secret_ref,default_language,supported_languages,status)
 VALUES($1,'Synthetic',$2,$3,$4,'en',ARRAY['en'],'active') RETURNING id`,[brand.id,randomUUID(),ref,randomUUID()]);
 const binding={appKey:`test-${randomUUID()}`,botId:String(bot.id),origin,tokenSecretRef:ref};
 const secret=randomBytes(32).toString('hex');
 let connection=db;
 if(runtime) {
  await db.query("DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='telegram_app') THEN CREATE ROLE telegram_app NOLOGIN; END IF; END $$");
  await db.query(await readFile('db/runtime-grants.sql','utf8'));
  connection={query:(sql,params)=>db.transaction(async tx=>{await tx.query('SET LOCAL ROLE telegram_app');return tx.query(sql,params);}),
   transaction:fn=>db.transaction(async tx=>{await tx.query('SET LOCAL ROLE telegram_app');return fn(tx);})};
 }
 const config={bindings:[binding]};
 const makeApp=(database=connection)=>{const app=createApp(database,r=>r===ref?secret:undefined,async()=>{throw new DomainError('unauthorized',401);},adminConfig,config);apps.push(app);return app;};
 const app=makeApp();const remoteAddress=`2001:db8:${randomBytes(2).toString('hex')}:${randomBytes(2).toString('hex')}:${++counter}::1`;
 const signed=(id=111,extra:Record<string,unknown>={},authDate=Math.floor(Date.now()/1000))=>{
  const p=new URLSearchParams({auth_date:String(authDate),query_id:randomUUID(),user:JSON.stringify({id,first_name:'Synthetic',language_code:'pt-BR',...extra})});p.sort();
  const key=createHmac('sha256','WebAppData').update(secret).digest();
  p.set('hash',createHmac('sha256',key).update(Array.from(p,([k,v])=>`${k}=${v}`).join('\n')).digest('hex'));return p.toString();
 };
 const exchange=(raw=signed(),chosenApp=app,extra:Record<string,unknown>={})=>chosenApp.inject({method:'POST',url:'/v1/mini/auth/exchange',remoteAddress,headers:{origin},payload:{appKey:binding.appKey,initData:raw,...extra}});
 const get=(token?:string,headers:Record<string,string>={},url='/v1/mini/me')=>app.inject({url,headers:{...(token?{authorization:`Bearer ${token}`} :{}),...headers}});
 return {brand,bot,binding,secret,config,app,connection,makeApp,signed,exchange,get,remoteAddress};
}
async function login(f:Awaited<ReturnType<typeof fixture>>,raw=f.signed()) {
 const res=await f.exchange(raw);assert.equal(res.statusCode,200,res.body);return res.json().token as string;
}
async function counts(botId:string) {
 const out:Record<string,number>={};for(const table of ['telegram_users','mini_sessions','mini_auth_exchanges','point_accounts','referrals','telegram_updates','audit_logs'])
 out[table]=Number((await one(db,`SELECT count(*) AS n FROM ${table} WHERE bot_id=$1`,[botId])).n);return out;
}
test('mini HTTP: exchange, hashed session, me, logout, no cookies/business side effects',async()=>{
 const f=await fixture();const response=await f.exchange();assert.equal(response.statusCode,200,response.body);
 const token=response.json().token;assert.match(token,/^[a-f0-9]{64}$/);assert.equal(response.headers['set-cookie'],undefined);
 assert.equal(response.headers['cache-control'],'no-store');assert.equal(response.headers['access-control-allow-credentials'],undefined);
 const row=await one(db,'SELECT * FROM mini_sessions WHERE bot_id=$1',[f.bot.id]);assert.equal(row.token_hash,miniDigest(token));assert.notEqual(row.token_hash,token);
 const me=await f.get(token);assert.equal(me.statusCode,200);assert.equal(me.json().botId,f.bot.id);assert.equal(me.json().brandId,f.brand.id);
 const user=await one(db,'SELECT * FROM telegram_users WHERE id=$1',[me.json().userId]);assert.equal(user.first_started_at,null);assert.equal(user.preferred_language,null);
 assert.deepEqual(await counts(f.bot.id),{telegram_users:1,mini_sessions:1,mini_auth_exchanges:1,point_accounts:0,referrals:0,telegram_updates:0,audit_logs:1});
 const res=await f.app.inject({method:'POST',url:'/v1/mini/auth/logout',headers:{origin,authorization:`Bearer ${token}`},payload:{}});assert.equal(res.statusCode,200);
 assert.equal((await f.get(token)).statusCode,401);assert.equal(Number((await one(db,"SELECT count(*) AS n FROM audit_logs WHERE bot_id=$1 AND action='mini.auth.logout'",[f.bot.id])).n),1);
});
test('mini: replay canonicalization and process restart do not issue a second session',async()=>{
 const f=await fixture();const raw=f.signed();const token=await login(f,raw);
 for(const value of [raw,raw.split('&').reverse().join('&')]) {const res=await f.exchange(value,f.makeApp());assert.equal(res.statusCode,401);assert.equal(res.json().error,'mini_init_data_used');}
 const newApp=f.makeApp();assert.equal((await newApp.inject({url:'/v1/mini/me',headers:{authorization:`Bearer ${token}`}})).statusCode,200);
 assert.equal((await counts(f.bot.id)).mini_sessions,1);
});
test('mini: existing user preserves preferred language, start and status',async()=>{
 const f=await fixture();await login(f);const user=await one(db,'SELECT * FROM telegram_users WHERE bot_id=$1',[f.bot.id]);
 await db.query("UPDATE telegram_users SET preferred_language='zh-CN',first_started_at='2025-01-01' WHERE id=$1",[user.id]);
 await login(f,f.signed(111,{username:'updated'}));
 const changed=await one(db,'SELECT * FROM telegram_users WHERE id=$1',[user.id]);assert.equal(changed.preferred_language,'zh-CN');assert.equal(changed.username,'updated');assert.ok(changed.first_started_at);
 for(const status of ['blocked','disabled']) {await db.query('UPDATE telegram_users SET status=$2 WHERE id=$1',[user.id,status]);assert.equal((await f.exchange()).statusCode,401);}
 assert.equal((await counts(f.bot.id)).telegram_users,1);
});
for(const reason of ['signature','expired','wrongBot','missingSecret','disabledBot','disabledBrand','wrongRef','unknownApp']) test(`mini: ${reason} fails without identity writes`,async()=>{
 const f=await fixture();let raw=f.signed(),app=f.app,extra={};
 if(reason==='signature') raw=raw.replace('Synthetic','Modified');
 if(reason==='expired') raw=f.signed(111,{},Math.floor(Date.now()/1000)-301);
 if(reason==='wrongBot') raw=(await fixture()).signed();
 if(reason==='missingSecret') {app=createApp(db,()=>undefined,async()=>{throw new DomainError('unauthorized',401);},adminConfig,f.config);apps.push(app);}
 if(reason==='disabledBot') await db.query("UPDATE telegram_bots SET status='disabled' WHERE id=$1",[f.bot.id]);
 if(reason==='disabledBrand') await db.query("UPDATE brands SET status='disabled' WHERE id=$1",[f.brand.id]);
 if(reason==='wrongRef') await db.query('UPDATE telegram_bots SET token_secret_ref=$2 WHERE id=$1',[f.bot.id,randomUUID()]);
 if(reason==='unknownApp') extra={appKey:'unknown'};
 assert.equal((await f.exchange(raw,app,extra)).statusCode,401);
 assert.deepEqual(await counts(f.bot.id),{telegram_users:0,mini_sessions:0,mini_auth_exchanges:0,point_accounts:0,referrals:0,telegram_updates:0,audit_logs:0});
});
test('mini: expiry, revocation and disabled scope stop existing sessions',async()=>{
 for(const reason of ['expiry','revoke','user','bot','brand']) {
  const f=await fixture(),token=await login(f);const row=await one(db,'SELECT * FROM mini_sessions WHERE token_hash=$1',[miniDigest(token)]);
  if(reason==='expiry') await db.query("UPDATE mini_sessions SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE id=$1",[row.id]);
  if(reason==='revoke') await db.query("UPDATE mini_sessions SET revoked_at=now(),revoke_reason='maintenance' WHERE id=$1",[row.id]);
  if(reason==='user') await db.query("UPDATE telegram_users SET status='disabled' WHERE id=$1",[row.user_id]);
  if(reason==='bot') await db.query("UPDATE telegram_bots SET status='disabled' WHERE id=$1",[f.bot.id]);
  if(reason==='brand') await db.query("UPDATE brands SET status='disabled' WHERE id=$1",[f.brand.id]);
  assert.equal((await f.get(token)).statusCode,401,reason);
 }
});
test('mini: query/body identity injection rejected; different users, brands and Bots stay separate',async()=>{
 const a=await fixture(),b=await fixture();const ta=await login(a),tb=await login(b),ta2=await login(a,a.signed(222));
 assert.notEqual((await a.get(ta)).json().userId,(await a.get(ta2)).json().userId);
 assert.equal((await a.get(tb)).statusCode,401);
 for(const field of ['userId','brandId','botId','telegramId']) {
  assert.equal((await a.get(ta,{},`/v1/mini/me?${field}=123`)).statusCode,400);
  assert.equal((await a.exchange(a.signed(),a.app,{[field]:'123'})).statusCode,400);
 }
 assert.equal((await a.app.inject({url:`/v1/brands/${b.brand.id}/bots/${b.bot.id}/users`,headers:{authorization:`Bearer ${ta}`}})).statusCode,401);
});
test('mini: exact per-app Origin, CORS, no ambient cookie auth',async()=>{
 const f=await fixture(),token=await login(f);
 for(const badOrigin of ['https://evil.example.test','null',origin+'/']) assert.equal((await f.get(token,{origin:badOrigin})).statusCode,403);
 assert.equal((await f.get(undefined,{cookie:`__Host-telegram_ops_session=${token}`})).statusCode,401);
 assert.equal((await f.get(token,{origin})).statusCode,200);
 for(const path of ['exchange','logout']) {
  const url=`/v1/mini/auth/${path}`;
  assert.equal((await f.app.inject({method:'POST',url,payload:{}})).statusCode,403);
  assert.equal((await f.app.inject({method:'POST',url,headers:{origin,'content-type':'text/plain'},payload:'{}'})).statusCode,415);
 }
 const preflight=await f.app.inject({method:'OPTIONS',url:'/v1/mini/me',headers:{origin,'access-control-request-method':'GET','access-control-request-headers':'authorization'}});
 assert.equal(preflight.statusCode,204);assert.equal(preflight.headers['access-control-allow-origin'],origin);assert.equal(preflight.headers['access-control-allow-credentials'],undefined);
 assert.equal((await f.app.inject({method:'OPTIONS',url:'/v1/mini/me',headers:{origin,'access-control-request-method':'GET','access-control-request-headers':'cookie'}})).statusCode,403);
});
test('mini: other configured app Origin cannot use this app session or exchange',async()=>{
 const a=await fixture(),b=await fixture();b.binding.origin='https://other-mini.example.test';a.config.bindings.push(b.binding);
 const token=await login(a);assert.equal((await a.get(token,{origin:b.binding.origin})).statusCode,403);
 const response=await a.app.inject({method:'POST',url:'/v1/mini/auth/exchange',headers:{origin:b.binding.origin},payload:{appKey:a.binding.appKey,initData:a.signed()}});assert.equal(response.statusCode,403);
});
test('mini and administrator principals never substitute; existing cookie flags/CSRF remain',async()=>{
 const f=await fixture(),miniToken=await login(f),password=randomBytes(32).toString('hex'),adminLogin=`mini-admin-${randomUUID()}`;
 const admin=await one(db,"INSERT INTO admins(auth_subject,display_name) VALUES($1,'Synthetic admin') RETURNING id",[randomUUID()]);
 await db.query('INSERT INTO admin_credentials(admin_id,login,password_hash) VALUES($1,$2,$3)',[admin.id,adminLogin,await hashPassword(password)]);
 const response=await f.app.inject({method:'POST',url:'/v1/auth/login',headers:{origin:adminOrigin,'x-csrf-protection':'1'},payload:{login:adminLogin,password}});assert.equal(response.statusCode,200);
 const setCookie=String(response.headers['set-cookie']);for(const flag of ['Secure','HttpOnly','SameSite=Lax','Path=/']) assert.ok(setCookie.includes(flag));
 const cookie=setCookie.split(';')[0]!;
 assert.equal((await f.app.inject({url:'/v1/me',headers:{cookie,origin:adminOrigin}})).statusCode,200);
 assert.equal((await f.get(undefined,{cookie})).statusCode,401);
 const adminToken=cookie.split('=')[1]!;assert.equal((await f.get(adminToken)).statusCode,401);
 assert.equal((await f.app.inject({url:'/v1/me',headers:{authorization:`Bearer ${miniToken}`,origin:adminOrigin}})).statusCode,401);
 assert.equal((await f.app.inject({method:'POST',url:'/v1/auth/logout',headers:{cookie,origin:adminOrigin},payload:{}})).statusCode,403);
 assert.equal((await f.app.inject({method:'POST',url:'/v1/auth/logout',headers:{cookie,origin:adminOrigin,'x-csrf-token':response.json().csrfToken},payload:{}})).statusCode,204);
});
test('mini: authentication disabled by default creates no Mini route or database accesses',async()=>{
 const app=createApp(db,()=>undefined,async()=>{throw new DomainError('unauthorized',401);},adminConfig);apps.push(app);
 assert.equal((await app.inject({url:'/v1/mini/me'})).statusCode,404);
});
test('mini: PostgreSQL-backed throttles shared between app instances, separate from admin',async()=>{
 const f=await fixture();const adminBucket=miniDigest(randomUUID());
 await db.query('INSERT INTO admin_login_limits(bucket_hash,attempts) VALUES($1,3)',[adminBucket]);
 for(let i=0;i<50;i++) assert.equal((await f.exchange(f.signed(),i%2?f.makeApp():f.app,{appKey:'unknown'})).statusCode,401);
 assert.equal((await f.exchange()).statusCode,429);assert.equal(Number((await one(db,'SELECT attempts FROM admin_login_limits WHERE bucket_hash=$1',[adminBucket])).attempts),3);
 const key=randomUUID();for(let i=0;i<10;i++) await miniRateLimit(db,key,10);await assert.rejects(miniRateLimit(db,key,10),/mini_rate_limited/);
});
test('mini: audit failure rolls back exchange, user and session; same initData can retry',async()=>{
 const f=await fixture();const faulty:Database={query:db.query.bind(db),transaction:fn=>db.transaction(tx=>fn({query:async(sql,params)=>{
  if(sql.includes('INSERT INTO audit_logs')) throw new Error('synthetic-audit-failure');return tx.query(sql,params);
 }}))};
 const raw=f.signed();assert.equal((await f.exchange(raw,f.makeApp(faulty))).statusCode,500);
 assert.equal((await counts(f.bot.id)).telegram_users,0);assert.equal((await counts(f.bot.id)).mini_auth_exchanges,0);assert.equal((await counts(f.bot.id)).mini_sessions,0);
 await login(f,raw);
});
test('mini: restricted runtime can exchange/read/logout but cannot alter identities, hashes, delete or balance',async()=>{
 const f=await fixture(true),token=await login(f);assert.equal((await f.get(token)).statusCode,200);
 assert.equal((await f.app.inject({method:'POST',url:'/v1/mini/auth/logout',headers:{origin,authorization:`Bearer ${token}`},payload:{}})).statusCode,200);
 for(const sql of ["UPDATE mini_sessions SET user_id=gen_random_uuid()", "UPDATE mini_sessions SET token_hash=repeat('a',64)",
  'DELETE FROM mini_sessions','DELETE FROM mini_auth_exchanges','UPDATE point_accounts SET balance=0','CREATE TABLE mini_forbidden(id int)'])
  await assert.rejects(f.connection.query(sql),sql);
});
const pgTest=(name:string,fn:()=>Promise<void>)=>test(name,{skip:!process.env.TEST_DATABASE_URL,timeout:30000},fn);
pgTest('mini PG17: simultaneous independent connections exchange once and webhook user remains unique',async()=>{
 const f=await fixture();const version=await one(db,"SELECT current_setting('server_version_num') AS n");assert.equal(Math.floor(Number(version.n)/10000),17);
 const raw=f.signed();let arrivals=0,release!:()=>void;const gate=new Promise<void>(r=>release=r);const pids=new Set<number>();
 const concurrent:Database={query:db.query.bind(db),transaction:fn=>db.transaction(async tx=>{
  pids.add(Number((await one(tx,'SELECT pg_backend_pid() AS pid')).pid));if(++arrivals===4) release();await gate;return fn(tx);
 })};
 const results=await Promise.allSettled(Array.from({length:4},()=>exchangeMiniSession(concurrent,f.binding,raw,f.secret,randomUUID())));
 assert.equal(pids.size,4);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 for(const r of results) if(r.status==='rejected') assert.match(String(r.reason),/mini_init_data_used/);
 assert.equal((await counts(f.bot.id)).mini_sessions,1);
 const next=f.signed(333);
 await Promise.all([exchangeMiniSession(db,f.binding,next,f.secret,randomUUID()),handleUpdate(db,f.bot.id,'synthetic-webhook',{update_id:1,message:{from:{id:333,first_name:'Test'},text:'/start'}},()=> 'synthetic-webhook')]);
 assert.equal(Number((await one(db,'SELECT count(*) AS n FROM telegram_users WHERE bot_id=$1 AND telegram_user_id=333',[f.bot.id])).n),1);
 console.log(`MINI_CONCURRENCY_PROOF: ${pids.size} independent PostgreSQL backends`);
});
test('mini: session/exchange composite foreign keys reject cross-Brand/Bot/user records',async()=>{
 const a=await fixture(),b=await fixture();await login(a);await login(b);
 const sa=await one(db,'SELECT * FROM mini_sessions WHERE bot_id=$1',[a.bot.id]);const sb=await one(db,'SELECT * FROM mini_sessions WHERE bot_id=$1',[b.bot.id]);
 for(const patch of [{user:sb.user_id,brand:a.brand.id,bot:a.bot.id},{user:sa.user_id,brand:b.brand.id,bot:a.bot.id},{user:sa.user_id,brand:a.brand.id,bot:b.bot.id}]) {
  await assert.rejects(db.query('UPDATE mini_sessions SET user_id=$2,brand_id=$3,bot_id=$4 WHERE id=$1',[sa.id,patch.user,patch.brand,patch.bot]));
 }
});
test('mini: active same-Brand sibling Bot does not share users or sessions',async()=>{
 const a=await fixture(),b=await fixture();await db.query('UPDATE telegram_bots SET brand_id=$2 WHERE id=$1',[b.bot.id,a.brand.id]);
 a.config.bindings.push(b.binding);
 const app=createApp(db,r=>r===a.binding.tokenSecretRef?a.secret:r===b.binding.tokenSecretRef?b.secret:undefined,async()=>{throw new DomainError('unauthorized',401);},adminConfig,a.config);apps.push(app);
 const ra=await a.exchange(a.signed(),app),rb=await b.exchange(b.signed(),app);assert.equal(ra.statusCode,200);assert.equal(rb.statusCode,200);
 const me=async(token:string)=>(await app.inject({url:'/v1/mini/me',headers:{authorization:`Bearer ${token}`}})).json();
 const pa=await me(ra.json().token),pb=await me(rb.json().token);assert.equal(pa.brandId,pb.brandId);assert.notEqual(pa.botId,pb.botId);assert.notEqual(pa.userId,pb.userId);
});
test('mini: removing configured binding immediately invalidates its Session',async()=>{
 const f=await fixture(),token=await login(f),other=await fixture();
 const app=createApp(db,()=>undefined,async()=>{throw new DomainError('unauthorized',401);},adminConfig,other.config);apps.push(app);
 assert.equal((await app.inject({url:'/v1/mini/me',headers:{authorization:`Bearer ${token}`}})).statusCode,401);
});
test('mini: database unavailable fails closed with safe response',async()=>{
 const f=await fixture();const broken:Database={query:async()=>{throw new Error('synthetic-database-secret-canary');},transaction:async()=>{throw new Error('synthetic-database-secret-canary');}};
 const res=await f.exchange(f.signed(),f.makeApp(broken));assert.equal(res.statusCode,500);assert.doesNotMatch(res.body,/synthetic-database-secret-canary/);
});
pgTest('mini PG17: concurrent rate limit increments cannot bypass threshold',async()=>{
 const key=randomUUID();const results=await Promise.allSettled(Array.from({length:20},()=>miniRateLimit(db,key,5)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,5);
 assert.equal(Number((await one(db,'SELECT attempts FROM mini_auth_limits WHERE bucket_hash=$1',[miniDigest(key)])).attempts),20);
});
pgTest('mini PG17 HTTP: real socket exchange/me/logout without Cookie or Telegram network calls',async()=>{
 const f=await fixture();await f.app.listen({host:'127.0.0.1',port:0});const address=f.app.server.address();
 assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}/v1/mini`;
 const exchanged=await fetch(`${base}/auth/exchange`,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({appKey:f.binding.appKey,initData:f.signed()})});
 assert.equal(exchanged.status,200);assert.equal(exchanged.headers.get('set-cookie'),null);
 const {token}=await exchanged.json() as {token:string};const headers={authorization:`Bearer ${token}`,origin};
 const me=await fetch(`${base}/me`,{headers});assert.equal(me.status,200);assert.equal((await me.json() as {botId:string}).botId,f.bot.id);
 const logout=await fetch(`${base}/auth/logout`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:'{}'});assert.equal(logout.status,200);
 assert.equal((await fetch(`${base}/me`,{headers})).status,401);
});
