import {readFile} from 'node:fs/promises';
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHmac} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {postgres,one,DomainError,type Database,type Queryable} from '../src/db.js';
import {migrate} from '../src/migrations.js';
import {createApp} from '../src/app.js';
import {postPoints} from '../src/points.js';
import {miniDigest} from '../src/mini-sessions.js';
let db:Database,close:()=>Promise<void>;const apps:ReturnType<typeof createApp>[]=[];
const adapt=(p:any):Queryable=>({query:async(s,a)=>a===undefined?(await p.exec(s)).at(-1)??{rows:[]}:p.query(s,a)});
before(async()=>{if(process.env.TEST_DATABASE_URL){const p=postgres(process.env.TEST_DATABASE_URL);db=p;close=p.close;}else{const p=new PGlite();db={...adapt(p),transaction:f=>p.transaction(t=>f(adapt(t)))};close=()=>p.close();}await migrate(db);});
after(async()=>{await Promise.all(apps.map(a=>a.close()));await close();});
const origin='https://mini-v1.example.test';
async function fixture(runtime=false){
 const brand=await one(db,"INSERT INTO brands(name,slug,default_language) VALUES('P2 Synthetic',$1,'en') RETURNING id",[randomUUID()]);const ref='P2_'+randomUUID().replaceAll('-','').toUpperCase();
 const bot=await one(db,"INSERT INTO telegram_bots(brand_id,name,username,token_secret_ref,webhook_secret_ref,default_language,supported_languages,status) VALUES($1,'P2 Bot',$2,$3,$4,'en',ARRAY['en'],'active') RETURNING id",[brand.id,randomUUID(),ref,randomUUID()]);
 const secret=randomUUID(),binding={appKey:'p2-'+randomUUID(),botId:bot.id,origin,tokenSecretRef:ref};
 let connection=db;
 if(runtime){
  await db.query("DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='telegram_app') THEN CREATE ROLE telegram_app NOLOGIN; END IF; END $$");
  await db.query(await readFile('db/runtime-grants.sql','utf8'));
  connection={query:(sql,params)=>db.transaction(async tx=>{await tx.query('SET LOCAL ROLE telegram_app');return tx.query(sql,params);}),transaction:fn=>db.transaction(async tx=>{await tx.query('SET LOCAL ROLE telegram_app');return fn(tx);})};
 }
 const app=createApp(connection,r=>r===ref?secret:undefined,async()=>{throw new DomainError('unauthorized',401);},undefined,{bindings:[binding]});apps.push(app);
 const signed=(id=121,date=Math.floor(Date.now()/1000))=>{const p=new URLSearchParams({auth_date:String(date),query_id:randomUUID(),user:JSON.stringify({id,first_name:'Private Name'})});p.sort();p.set('hash',createHmac('sha256',createHmac('sha256','WebAppData').update(secret).digest()).update([...p].map(([k,v])=>`${k}=${v}`).join('\n')).digest('hex'));return p.toString();};
 const exchange=(raw=signed(),recovery=true)=>app.inject({method:'POST',url:'/v1/mini/auth/exchange',headers:{origin,'x-mini-csrf':'1'},payload:{appKey:binding.appKey,initData:raw,recovery}});
 const recover=(cookie:string,raw:string,extra:Record<string,string>={})=>app.inject({method:'POST',url:'/v1/mini/auth/recover',headers:{origin,'x-mini-csrf':'1',cookie,...extra},payload:{appKey:binding.appKey,initData:raw}});
 const get=(token:string,url:string)=>app.inject({url:'/v1/mini/'+url,headers:{authorization:`Bearer ${token}`,origin}});
 return {brand,bot,app,binding,signed,exchange,recover,get};
}
test('V1 recovery: strict cookie, same session, refresh, logout and old recovery cannot restore',async()=>{
 const f=await fixture(),raw=f.signed(),first=await f.exchange(raw);assert.equal(first.statusCode,200);const cookie=String(first.headers['set-cookie']).split(';')[0]!;
 for(const attr of ['__Host-telegram_mini_recovery=','Secure','HttpOnly','SameSite=Lax','Path=/','Max-Age=1800'])assert.ok(String(first.headers['set-cookie']).includes(attr));assert.ok(!String(first.headers['set-cookie']).includes('Domain='));
 const token=first.json().token,restored=await f.recover(cookie,raw);assert.equal(restored.statusCode,200);assert.equal(restored.json().token,token);assert.equal(restored.json().expiresAt,first.json().expiresAt);
 assert.equal((await one(db,'SELECT count(*)::int AS n FROM mini_sessions WHERE bot_id=$1',[f.bot.id])).n,1);
 assert.equal((await f.exchange(raw)).statusCode,401);
 assert.equal((await f.get(token,'me')).statusCode,200);
 const logout=await f.app.inject({method:'POST',url:'/v1/mini/auth/logout',headers:{origin,authorization:`Bearer ${token}`},payload:{}});assert.equal(logout.statusCode,200);assert.match(String(logout.headers['set-cookie']),/Max-Age=0/);
 assert.equal((await f.get(token,'me')).statusCode,401);assert.equal((await f.recover(cookie,raw)).statusCode,401);
});
test('V1 recovery: missing CSRF, wrong Origin, admin cookie, wrong signed user/context rejected',async()=>{
 const f=await fixture(),raw=f.signed(),r=await f.exchange(raw),cookie=String(r.headers['set-cookie']).split(';')[0]!;
 assert.equal((await f.recover(cookie,raw,{'x-mini-csrf':''})).statusCode,403);
 assert.equal((await f.recover(cookie,raw,{origin:'https://evil.test'})).statusCode,403);
 assert.equal((await f.recover(cookie,raw,{'sec-fetch-site':'cross-site'})).statusCode,403);
 assert.equal((await f.recover('__Host-telegram_ops_session='+r.json().token,raw)).statusCode,401);
 assert.equal((await f.recover(cookie,f.signed(122))).statusCode,401);
 assert.equal((await f.recover(cookie,f.signed())).statusCode,401);
 assert.equal((await f.recover(cookie,'tampered')).statusCode,401);
 assert.equal((await f.app.inject({url:'/v1/mini/me',headers:{cookie}})).statusCode,401);
 assert.equal((await f.app.inject({url:'/v1/me',headers:{cookie,authorization:`Bearer ${r.json().token}`}})).statusCode,404);
});
test('V1 recovery: original exchange retains 5 minute expiry, recovery never extends 30 minute session',async()=>{
 const f=await fixture(),r=await f.exchange(),token=r.json().token;
 await db.query("UPDATE mini_sessions SET created_at=now()-interval '1 hour',expires_at=now()-interval '1 minute' WHERE token_hash=$1",[miniDigest(token)]);
 assert.equal((await f.recover(String(r.headers['set-cookie']).split(';')[0]!,f.signed())).statusCode,401);
 assert.equal((await f.exchange(f.signed(122,Math.floor(Date.now()/1000)-400))).statusCode,401);
});
test('V1 queries: own scope, bigint precision, pagination, no business creation, no private metadata',async()=>{
 const f=await fixture(),a=(await f.exchange()).json().token,b=(await f.exchange(f.signed(122))).json().token;
 const aId=(await f.get(a,'me')).json().userId,bId=(await f.get(b,'me')).json().userId;
 const home=(await f.get(a,'home')).json();assert.deepEqual(home.points,{accountExists:false,balance:null});assert.equal(home.invitedCount,'0');
 for(const path of ['point-ledger','referrals','redemptions'])assert.deepEqual((await f.get(a,path)).json(),{items:[],nextCursor:null});
 assert.deepEqual((await f.get(a,'activities')).json(),{items:[],participationEnabled:false,catalogueStatus:'not_published'});
 assert.equal((await one(db,'SELECT count(*)::int AS n FROM point_accounts WHERE bot_id=$1',[f.bot.id])).n,0);
 for(let i=0;i<2;i++)await db.transaction(tx=>postPoints(tx,{brandId:f.brand.id,botId:f.bot.id,userId:aId,delta:'9007199254740993',source:'test',businessType:'test',businessId:randomUUID(),idempotencyKey:randomUUID(),note:'PRIVATE_NOTE'}));
 assert.equal((await f.get(a,'points')).json().balance,'18014398509481986');assert.equal((await f.get(b,'points')).json().accountExists,false);
 const page=(await f.get(a,'point-ledger?limit=1')).json();assert.equal(page.items.length,1);assert.ok(page.nextCursor);assert.equal((await f.get(a,'point-ledger?cursor='+page.nextCursor)).json().items.length,1);
 assert.equal((await f.get(b,'point-ledger?cursor='+page.nextCursor)).statusCode,400);
 for(const key of ['brandId','botId','userId'])assert.equal((await f.get(a,'home?'+key+'='+bId)).statusCode,400);
 assert.ok(!JSON.stringify(page).includes('PRIVATE_NOTE'));assert.ok(!JSON.stringify(home).includes(f.brand.id));
 const other=await fixture();assert.equal((await other.get(a,'home')).statusCode,401);
 await db.query("INSERT INTO referrals(brand_id,bot_id,inviter_id,invitee_id,start_parameter) VALUES($1,$2,$3,$4,'test')",[f.brand.id,f.bot.id,aId,bId]);
 assert.equal((await f.get(a,'referrals')).json().items.length,1);assert.equal((await f.get(b,'referrals')).json().items.length,0);
});
test('V1 limits: shared proxy/forged forwarding metadata cannot consume valid users budget',async()=>{
 const f=await fixture();for(let i=0;i<52;i++)await f.exchange('bad');
 assert.equal((await f.exchange(f.signed(123))).statusCode,200);
 assert.equal((await f.exchange(f.signed(124))).statusCode,200);
 for(let i=0;i<9;i++)assert.equal((await f.exchange(f.signed(123))).statusCode,200);
 assert.equal((await f.exchange(f.signed(123))).statusCode,429);
 assert.equal((await f.exchange(f.signed(125))).statusCode,200);
});
test('V1 recovery after 5 minutes requires cookie; expired initData cannot create a new session',async t=>{
 const f=await fixture(),raw=f.signed(),r=await f.exchange(raw),cookie=String(r.headers['set-cookie']).split(';')[0]!;
 const now=Date.now();t.mock.method(Date,'now',()=>now+400000);
 assert.equal((await f.recover(cookie,raw)).statusCode,200);
 assert.equal((await f.exchange(raw)).statusCode,401);
 assert.equal((await f.recover('',raw)).statusCode,401);
});
test('V1 recovery exact Bot binding, active user/Brand/Bot and duplicate cookies fail closed',async()=>{
 const f=await fixture(),raw=f.signed(),r=await f.exchange(raw),cookie=String(r.headers['set-cookie']).split(';')[0]!;
 assert.equal((await f.recover(cookie+'; '+cookie,raw)).statusCode,401);
 const other=await fixture();assert.equal((await other.recover(cookie,raw)).statusCode,401);
 await db.query("UPDATE telegram_bots SET status='disabled' WHERE id=$1",[f.bot.id]);assert.equal((await f.recover(cookie,raw)).statusCode,401);
 await db.query("UPDATE telegram_bots SET status='active' WHERE id=$1",[f.bot.id]);await db.query("UPDATE brands SET status='disabled' WHERE id=$1",[f.brand.id]);assert.equal((await f.recover(cookie,raw)).statusCode,401);
});
test('V1 redemption read exposes own status/cost only, never rule secrets or another user',async()=>{
 const f=await fixture(),a=(await f.exchange()).json().token,b=(await f.exchange(f.signed(122))).json().token;
 const uid=(await f.get(a,'me')).json().userId;
 const rule=await one(db,"INSERT INTO redemption_rules(brand_id,bot_id,name,mode,points_cost,exchange_rate) VALUES($1,$2,'Test','fixed',10,1) RETURNING id",[f.brand.id,f.bot.id]);
 await db.query("INSERT INTO redemptions(brand_id,bot_id,user_id,rule_id,points_cost,idempotency_key,rule_snapshot,failure_reason) VALUES($1,$2,$3,$4,10,$5,$6,'PRIVATE_FAILURE')",[f.brand.id,f.bot.id,uid,rule.id,randomUUID(),JSON.stringify({private:'PRIVATE_SNAPSHOT'})]);
 const r=await f.get(a,'redemptions');assert.equal(r.json().items[0].points_cost,'10');assert.equal(r.json().items[0].status,'pending');assert.ok(!r.body.includes('PRIVATE_'));assert.equal((await f.get(b,'redemptions')).json().items.length,0);
});
test('V1 same-brand second Bot cannot read first Bot records or reuse its recovery cookie',async()=>{
 const f=await fixture(),raw=f.signed(),r=await f.exchange(raw),a=r.json().token;
 const other=await one(db,"INSERT INTO telegram_bots(brand_id,name,username,token_secret_ref,webhook_secret_ref,default_language,supported_languages,status) VALUES($1,'Other',$2,$3,$4,'en',ARRAY['en'],'active') RETURNING id",[f.brand.id,randomUUID(),randomUUID(),randomUUID()]);
 for(const route of ['home','points','point-ledger','referrals','redemptions','activities'])assert.equal((await f.get(a,route+'?botId='+other.id)).statusCode,400);
});
test('V1 existing runtime grants support recovery and all read routes without new grants',async()=>{
 const f=await fixture(true),raw=f.signed(),r=await f.exchange(raw);assert.equal(r.statusCode,200);
 const cookie=String(r.headers['set-cookie']).split(';')[0]!;assert.equal((await f.recover(cookie,raw)).statusCode,200);
 for(const route of ['home','points','point-ledger','referrals','redemptions','activities'])assert.equal((await f.get(r.json().token,route)).statusCode,200);
});
test('V1 concurrent recovery returns the same existing session, no duplicate exchanges',async()=>{
 const f=await fixture(),raw=f.signed(),r=await f.exchange(raw),cookie=String(r.headers['set-cookie']).split(';')[0]!;
 const recovered=await Promise.all(Array.from({length:5},()=>f.recover(cookie,raw)));assert.ok(recovered.every(x=>x.statusCode===200&&x.json().token===r.json().token));
 assert.equal((await one(db,'SELECT count(*)::int AS n FROM mini_sessions WHERE bot_id=$1',[f.bot.id])).n,1);
 assert.equal((await one(db,'SELECT count(*)::int AS n FROM mini_auth_exchanges WHERE bot_id=$1',[f.bot.id])).n,1);
});
test('V2.1 home exposes only own locale inputs without modifying message language or needing grants',async()=>{
 const f=await fixture(true),r=await f.exchange(),token=r.json().token;
 const uid=(await f.get(token,'me')).json().userId;
 await db.query("UPDATE telegram_users SET preferred_language='pt-BR',telegram_language_code='es' WHERE id=$1",[uid]);
 const profile=(await f.get(token,'home')).json().profile;
 assert.equal(profile.preferredLanguage,'pt-BR');assert.equal(profile.botLanguage,'en');assert.equal(profile.projectLanguage,'en');assert.equal(profile.telegramLanguage,'es');
 assert.equal((await f.get(token,'home?userId='+randomUUID())).statusCode,400);
 assert.equal((await one(db,'SELECT preferred_language FROM telegram_users WHERE id=$1',[uid])).preferred_language,'pt-BR');
});
