import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {postgres,one,type Database,type Scope} from '../src/db.js';
import {migrate} from '../src/migrations.js';
import {handleUpdate} from '../src/telegram.js';
import {postPoints} from '../src/points.js';
import {reserveRedemption,assignCode,failRedemption} from '../src/redemptions.js';
import {getTemplate} from '../src/language.js';
import {createApp} from '../src/app.js';

// This suite must never substitute PGlite for a real, multi-connection server.
const enabled=!!process.env.TEST_DATABASE_URL;
const pgTest=(name:string,fn:()=>Promise<void>)=>test(name,{skip:!enabled,timeout:30000},fn);
let db:ReturnType<typeof postgres>;
before(async()=>{
 if(!enabled) return;
 db=postgres(process.env.TEST_DATABASE_URL!);
 const version=await one(db,"SELECT current_setting('server_version_num') AS number,version() AS full");
 assert.equal(Math.floor(Number(version.number)/10000),17,'Acceptance requires PostgreSQL 17');
 console.log(`REAL_DATABASE: ${version.full}; NODE: ${process.version}`);
 await migrate(db);
});
after(async()=>{if(enabled) await db.close();});
async function fixture(brandId?:string,name='Bot') {
 if(!brandId) brandId=(await one(db,"INSERT INTO brands(name,slug,default_language) VALUES('Brand',$1,'pt-BR') RETURNING id",[randomUUID()])).id;
 const bot=await one(db,`INSERT INTO telegram_bots(brand_id,name,username,token_secret_ref,webhook_secret_ref,default_language,supported_languages,status)
 VALUES($1,$2,$3,$4,$5,'pt-BR',ARRAY['pt-BR','en','es-MX'],'active') RETURNING id`,[brandId,name,randomUUID(),randomUUID(),randomUUID()]);
 const s:Scope={brandId:brandId!,botId:bot.id};
 const user=await one(db,'INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id) VALUES($1,$2,777) RETURNING *',[s.brandId,s.botId]);
 return {s,user};
}
async function rule(s:Scope) {return one(db,`INSERT INTO redemption_rules(brand_id,bot_id,name,mode,points_cost,exchange_rate,enabled) VALUES($1,$2,'Fixed test','fixed',10,1,true) RETURNING id`,[s.brandId,s.botId]);}
function points(client:Database,s:Scope,userId:string,key:string,delta='100') {
 return client.transaction(tx=>postPoints(tx,{...s,userId,delta,source:'acceptance',businessType:'acceptance',businessId:key,idempotencyKey:key}));
}
function start(client:Database,s:Scope,updateId:number,userId=888,text='/start') {
 return handleUpdate(client,s.botId,'test-secret',{update_id:updateId,message:{from:{id:userId,language_code:'zh-CN'},text}},()=> 'test-secret');
}
async function consistent(s:Scope,expected?:string) {
 const rows=(await db.query(`SELECT a.balance::text,COALESCE(sum(l.delta),0)::text AS sum FROM point_accounts a
 LEFT JOIN point_ledger l ON l.account_id=a.id WHERE a.brand_id=$1 AND a.bot_id=$2 GROUP BY a.id`,[s.brandId,s.botId])).rows;
 assert.ok(rows.length>0);
 for(const row of rows) {assert.equal(row.balance,row.sum);if(expected!==undefined) assert.equal(row.balance,expected);}
}
// All contenders hold independent pool connections and BEGIN before any business
// operation proceeds. Distinct pg_backend_pid values prove true connection overlap.
async function race<T>(count:number,fn:(client:Database,index:number)=>Promise<T>):Promise<PromiseSettledResult<T>[]> {
 let arrivals=0,release!:()=>void,reject!: (error:Error)=>void;
 const pids=new Set<number>();
 const gate=new Promise<void>((resolve,fail)=>{release=resolve;reject=fail;});
 const timer=setTimeout(()=>reject(new Error('concurrency_barrier_timeout')),15000);
 const concurrent:Database={query:db.query.bind(db),transaction:work=>db.transaction(async tx=>{
  pids.add(Number((await one(tx,'SELECT pg_backend_pid() AS pid')).pid));
  if(++arrivals===count) release();
  await gate;
  return work(tx);
 })};
 try {
  const results=await Promise.allSettled(Array.from({length:count},(_,i)=>fn(concurrent,i)));
  assert.equal(arrivals,count);assert.equal(pids.size,count,'Each contender must use a separate PostgreSQL backend');
  console.log(`CONCURRENCY_PROOF: ${count} simultaneous transactions, ${pids.size} distinct backends`);
  return results;
 } finally {clearTimeout(timer);}
}
function successes<T>(results:PromiseSettledResult<T>[]):T[] {
 for(const result of results) if(result.status==='rejected') throw result.reason;
 return results.map(r=>(r as PromiseFulfilledResult<T>).value);
}
pgTest('PG17 concurrency 1: identical Telegram update is processed once',async()=>{
 const {s}=await fixture();const results=successes(await race(4,c=>start(c,s,1)));
 assert.equal(results.filter(r=>!r.duplicate).length,1);
 assert.equal((await db.query('SELECT * FROM telegram_updates WHERE bot_id=$1',[s.botId])).rows.length,1);
});
pgTest('PG17 concurrency 2: repeated credit and debit events each create one ledger',async()=>{
 const {s,user}=await fixture();
 const credited=successes(await race(4,c=>points(c,s,user.id,'credit')));assert.equal(new Set(credited.map(r=>r.id)).size,1);
 const debited=successes(await race(4,c=>points(c,s,user.id,'debit','-20')));assert.equal(new Set(debited.map(r=>r.id)).size,1);
 assert.equal((await db.query('SELECT * FROM point_ledger WHERE bot_id=$1',[s.botId])).rows.length,2);await consistent(s,'80');
});
pgTest('PG17 concurrency 3: distinct concurrent start updates create one user',async()=>{
 const {s}=await fixture();successes(await race(4,(c,i)=>start(c,s,i+1)));
 assert.equal((await db.query('SELECT * FROM telegram_users WHERE bot_id=$1 AND telegram_user_id=888',[s.botId])).rows.length,1);
 assert.equal((await db.query('SELECT * FROM telegram_updates WHERE bot_id=$1',[s.botId])).rows.length,4);
});
pgTest('PG17 concurrency 4: two inviters produce exactly one first binding',async()=>{
 const {s,user}=await fixture();
 const other=await one(db,'INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id) VALUES($1,$2,999) RETURNING *',[s.brandId,s.botId]);
 const inviters=[user,other];successes(await race(2,(c,i)=>start(c,s,i+1,888,`/start ref_${inviters[i]!.referral_code}`)));
 const rows=(await db.query('SELECT * FROM referrals WHERE bot_id=$1',[s.botId])).rows;assert.equal(rows.length,1);assert.ok(inviters.some(u=>u.id===rows[0]!.inviter_id));
 const winner=rows[0]!.inviter_id;await start(db,s,3,888,`/start ref_${inviters.find(u=>u.id!==winner)!.referral_code}`);
 assert.equal((await one(db,'SELECT inviter_id FROM referrals WHERE bot_id=$1',[s.botId])).inviter_id,winner);
});
pgTest('PG17 concurrency 5: repeated redemption reserves one order and debits once',async()=>{
 const {s,user}=await fixture();await points(db,s,user.id,'seed');const r=await rule(s);
 const results=successes(await race(4,c=>c.transaction(tx=>reserveRedemption(tx,s,user.id,r.id,'same-order'))));
 assert.equal(new Set(results.map(r=>r.id)).size,1);
 assert.equal((await db.query("SELECT id FROM point_ledger WHERE bot_id=$1 AND business_type='redemption_debit'",[s.botId])).rows.length,1);await consistent(s,'90');
});
pgTest('PG17 concurrency 6: two orders racing for one code have only one winner',async()=>{
 const {s,user}=await fixture();await points(db,s,user.id,'seed');const r=await rule(s);
 const a=await db.transaction(tx=>reserveRedemption(tx,s,user.id,r.id,'order-a'));
 const b=await db.transaction(tx=>reserveRedemption(tx,s,user.id,r.id,'order-b'));
 await db.query('INSERT INTO redemption_codes(brand_id,bot_id,rule_id,code_secret_ref,code_fingerprint) VALUES($1,$2,$3,$4,$5)',[s.brandId,s.botId,r.id,randomUUID(),randomUUID()]);
 const results=await race(2,(c,i)=>c.transaction(tx=>assignCode(tx,s,[a,b][i]!.id)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const failure=results.find(r=>r.status==='rejected') as PromiseRejectedResult;assert.match(failure.reason.message,/inventory_empty/);
 assert.equal((await db.query("SELECT id FROM redemption_codes WHERE bot_id=$1 AND status='assigned'",[s.botId])).rows.length,1);await consistent(s,'80');
});
pgTest('PG17 concurrency 7: simultaneous failure refunds only once',async()=>{
 const {s,user}=await fixture();await points(db,s,user.id,'seed');const r=await rule(s);
 const order=await db.transaction(tx=>reserveRedemption(tx,s,user.id,r.id,'refundable'));
 successes(await race(4,c=>c.transaction(tx=>failRedemption(tx,s,order.id,'acceptance failure'))));
 assert.equal((await db.query("SELECT id FROM point_ledger WHERE bot_id=$1 AND business_type='redemption_refund'",[s.botId])).rows.length,1);await consistent(s,'100');
});
pgTest('PG17 concurrency 8: distinct simultaneous events preserve balance equals ledger SUM',async()=>{
 const {s,user}=await fixture();await points(db,s,user.id,'seed');
 successes(await race(4,(c,i)=>points(c,s,user.id,`mixed-${i}`,['10','-20','30','-5'][i]!)));
 assert.equal((await db.query('SELECT id FROM point_ledger WHERE bot_id=$1',[s.botId])).rows.length,5);await consistent(s,'115');
});
pgTest('PG17 locks: FOR UPDATE visibly blocks another backend until commit',async()=>{
 const {s}=await fixture();let unlock!:()=>void,locked!:()=>void;
 const held=new Promise<void>(r=>{locked=r;}),release=new Promise<void>(r=>{unlock=r;});
 let firstPid=0,secondPid=0,secondDone=false;
 const first=db.transaction(async tx=>{firstPid=Number((await one(tx,'SELECT pg_backend_pid() AS pid')).pid);await tx.query('SELECT id FROM telegram_bots WHERE id=$1 FOR UPDATE',[s.botId]);locked();await release;});
 await held;
 const second=db.transaction(async tx=>{secondPid=Number((await one(tx,'SELECT pg_backend_pid() AS pid')).pid);await tx.query('SELECT id FROM telegram_bots WHERE id=$1 FOR UPDATE',[s.botId]);secondDone=true;});
 try {
  let blockers:number[]=[];
  for(let i=0;i<100;i++) {
   if(secondPid) blockers=(await one(db,'SELECT pg_blocking_pids($1) AS pids',[secondPid])).pids;
   if(blockers.includes(firstPid)) break;
   await new Promise(r=>setTimeout(r,20));
  }
  assert.notEqual(firstPid,secondPid);assert.ok(blockers.includes(firstPid),'PostgreSQL must report the first backend as blocking the second');assert.equal(secondDone,false);
 } finally {unlock();await Promise.all([first,second]);}
 assert.equal(secondDone,true);
});
pgTest('PG17 transactions: migration replay, constraints, triggers, rollback and ON CONFLICT',async()=>{
 await migrate(db);await migrate(db);assert.equal((await db.query('SELECT * FROM schema_migrations')).rows.length,3);
 const {s,user}=await fixture();const ledger=await points(db,s,user.id,'seed');
 await assert.rejects(()=>db.transaction(async tx=>{await postPoints(tx,{...s,userId:user.id,delta:'7',source:'acceptance',businessType:'acceptance',businessId:'rollback',idempotencyKey:'rollback'});throw new Error('rollback_probe');}),/rollback_probe/);
 await consistent(s,'100');
 await assert.rejects(()=>db.query('UPDATE point_accounts SET balance=500 WHERE user_id=$1',[user.id]),/use_point_ledger/);
 const sql=`INSERT INTO point_ledger(brand_id,bot_id,user_id,account_id,delta,balance_before,balance_after,source,business_type,business_id,idempotency_key)
 SELECT brand_id,bot_id,user_id,account_id,delta,0,0,source,business_type,business_id,idempotency_key FROM point_ledger WHERE id=$1`;
 await assert.rejects(()=>db.query(sql,[ledger.id]),(e:any)=>e.code==='23505');
 await db.query(`${sql} ON CONFLICT DO NOTHING`,[ledger.id]);await consistent(s,'100');
 assert.equal((await db.query('SELECT id FROM point_ledger WHERE bot_id=$1',[s.botId])).rows.length,1);
});
pgTest('PG17 isolation: Brand A A1/A2 and Brand B B1 enforce all service and API boundaries',async()=>{
 const a1=await fixture(undefined,'A1'),a2=await fixture(a1.s.brandId,'A2'),b1=await fixture(undefined,'B1');
 assert.equal((await db.query('SELECT id FROM telegram_users WHERE bot_id=ANY($1::uuid[]) AND telegram_user_id=777',[[a1.s.botId,a2.s.botId,b1.s.botId]])).rows.length,3);
 await points(db,a1.s,a1.user.id,'seed');const r=await rule(a1.s);
 for(const foreign of [a2,b1]) {
  await points(db,foreign.s,foreign.user.id,'seed');
  await assert.rejects(()=>points(db,a1.s,foreign.user.id,randomUUID()),(e:any)=>e.code==='23503');
  await assert.rejects(()=>getTemplate(db,a1.s,foreign.user.id,'WELCOME'),/not_found/);
  await assert.rejects(()=>db.transaction(tx=>reserveRedemption(tx,a1.s,foreign.user.id,r.id,randomUUID())),(e:any)=>e.code==='23503');
  await assert.rejects(()=>db.query('INSERT INTO referrals(brand_id,bot_id,inviter_id,invitee_id,start_parameter) VALUES($1,$2,$3,$4,$5)',[a1.s.brandId,a1.s.botId,foreign.user.id,a1.user.id,'ref_foreign']),(e:any)=>e.code==='23503');
  await db.query("INSERT INTO message_templates(brand_id,bot_id,template_key,language,body) VALUES($1,$2,'FOREIGN','pt-BR','Foreign only')",[foreign.s.brandId,foreign.s.botId]);
  await consistent(foreign.s,'100');
 }
 await assert.rejects(()=>getTemplate(db,a1.s,a1.user.id,'FOREIGN'),/template_missing/);
 const admin=await one(db,"INSERT INTO admins(auth_subject,display_name) VALUES($1,'A1 admin') RETURNING id",[randomUUID()]);
 await db.query("INSERT INTO admin_roles(admin_id,role_id,brand_id,bot_id) SELECT $1,id,$2,$3 FROM roles WHERE name='Admin'",[admin.id,a1.s.brandId,a1.s.botId]);
 const app=createApp(db,()=>undefined,async()=>({adminId:admin.id}));
 try {
  for(const foreign of [a2,b1]) {
   const base=`/v1/brands/${foreign.s.brandId}/bots/${foreign.s.botId}`;
   assert.equal((await app.inject({url:`${base}/users/${foreign.user.id}/points`})).statusCode,403);
   assert.equal((await app.inject({method:'POST',url:`${base}/points/adjustments`,headers:{'idempotency-key':randomUUID()},payload:{userId:foreign.user.id,delta:'1',eventId:randomUUID(),note:'must fail'}})).statusCode,403);
   assert.equal((await app.inject({url:`/v1/brands/${a1.s.brandId}/bots/${a1.s.botId}/users/${foreign.user.id}/points`})).statusCode,404);
  }
 } finally {await app.close();}
 await consistent(a1.s,'100');
});
pgTest('PG17 language: zh-CN admin and unsupported zh-CN Telegram user resolve pt-BR',async()=>{
 const {s,user}=await fixture();
 await db.query("INSERT INTO admins(auth_subject,display_name,ui_language) VALUES($1,'Chinese UI admin','zh-CN')",[randomUUID()]);
 await db.query("UPDATE telegram_users SET telegram_language_code='zh-CN',preferred_language=NULL WHERE id=$1",[user.id]);
 await db.query("INSERT INTO message_templates(brand_id,bot_id,template_key,language,body) VALUES($1,$2,'WELCOME','pt-BR','Olá')",[s.brandId,s.botId]);
 assert.equal((await getTemplate(db,s,user.id,'WELCOME')).language,'pt-BR');
});
