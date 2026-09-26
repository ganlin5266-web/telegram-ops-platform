import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate} from '../src/migrations.js';
import {postgres,one,type Database,type Queryable,type Scope} from '../src/db.js';
import {handleUpdate} from '../src/telegram.js';
import {postPoints} from '../src/points.js';
import {resolveLanguage,getTemplate} from '../src/language.js';
import {reserveRedemption,assignCode,failRedemption} from '../src/redemptions.js';
import {createApp} from '../src/app.js';
let db:Database;let close:()=>Promise<void>;
before(async()=>{
 if(process.env.TEST_DATABASE_URL) {const pg=postgres(process.env.TEST_DATABASE_URL);db=pg;close=pg.close;}
 else {
  const pg=new PGlite();
  const adapt=(client:any):Queryable=>({query:async(sql,params)=>params===undefined?(await client.exec(sql)).at(-1)??{rows:[]}:client.query(sql,params)});
  db={...adapt(pg),transaction:fn=>pg.transaction(tx=>fn(adapt(tx)))};close=()=>pg.close();
 }
 await migrate(db);
});
after(async()=>{await close();});
async function fixture() {
 const brand=await one(db,`INSERT INTO brands(name,slug,default_language) VALUES('Test',$1,'pt-BR') RETURNING id`,[randomUUID()]);
 const bot=await one<{id:string;brand_id:string;default_language:string;supported_languages:string[]}>(db,`INSERT INTO telegram_bots(brand_id,name,username,token_secret_ref,webhook_secret_ref,default_language,supported_languages,status) VALUES($1,'Test',$2,$3,$4,'pt-BR',ARRAY['pt-BR','es-MX','fil-PH','en'],'active') RETURNING *`,[brand.id,`bot_${randomUUID()}`,`TOKEN_${randomUUID()}`,`SECRET_${randomUUID()}`]);
 const s:Scope={brandId:brand.id,botId:bot.id};
 const user=await one(db,`INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id) VALUES($1,$2,123) RETURNING *`,[brand.id,bot.id]);
 return {s,bot,user};
}
const credit=(s:Scope,userId:string,event='credit',delta='100')=>db.transaction(tx=>postPoints(tx,{...s,userId,delta,source:'test',businessType:'test',businessId:event,idempotencyKey:event}));
async function rule(s:Scope) {return one(db,`INSERT INTO redemption_rules(brand_id,bot_id,name,mode,points_cost,exchange_rate,enabled) VALUES($1,$2,'Test','fixed',10,1,true) RETURNING *`,[s.brandId,s.botId]);}
async function start(botId:string,id:number,userId:number,text='/start') {return handleUpdate(db,botId,'test-secret',{update_id:id,message:{from:{id:userId,first_name:'Test',language_code:'es'},text}},()=> 'test-secret');}
test('migration replay is safe',async()=>{await migrate(db);assert.equal((await db.query('SELECT * FROM schema_migrations')).rows.length,7);});
test('duplicate updates process once, repeated starts preserve one identity',async()=>{
 const {s}=await fixture();const results=await Promise.all([start(s.botId,1,777),start(s.botId,1,777)]);
 assert.equal(results.filter(r=>r.duplicate).length,1);await start(s.botId,2,777);
 assert.equal((await db.query('SELECT id FROM telegram_users WHERE bot_id=$1 AND telegram_user_id=777',[s.botId])).rows.length,1);
 assert.equal((await db.query('SELECT * FROM telegram_updates WHERE bot_id=$1',[s.botId])).rows.length,2);
});
test('webhook rejects invalid secrets and invalid updates with no database writes',async()=>{
 const {s}=await fixture();await assert.rejects(()=>handleUpdate(db,s.botId,'bad',{update_id:1},()=> 'test-secret'),/unauthorized/);
 await assert.rejects(()=>handleUpdate(db,s.botId,'test-secret',{update_id:-1},()=> 'test-secret'));
 assert.equal((await db.query('SELECT * FROM telegram_updates WHERE bot_id=$1',[s.botId])).rows.length,0);
});
test('concurrent duplicate points credit once and conflicting reuse is rejected',async()=>{
 const {s,user}=await fixture();const rows=await Promise.all([credit(s,user.id),credit(s,user.id)]);assert.equal(rows[0].id,rows[1].id);
 await assert.rejects(()=>credit(s,user.id,'credit','101'),/idempotency_conflict/);
 const account=await one(db,'SELECT balance FROM point_accounts WHERE user_id=$1',[user.id]);assert.equal(String(account.balance),'100');
});
test('ledger sums equal account balance; direct balance changes and ledger deletion fail',async()=>{
 const {s,user}=await fixture();await credit(s,user.id);await credit(s,user.id,'debit','-25');
 const totals=await one(db,'SELECT sum(delta)::text AS total FROM point_ledger WHERE user_id=$1',[user.id]);
 assert.equal(totals.total,'75');assert.equal(String((await one(db,'SELECT balance FROM point_accounts WHERE user_id=$1',[user.id])).balance),totals.total);
 await assert.rejects(()=>db.query('UPDATE point_accounts SET balance=999 WHERE user_id=$1',[user.id]),/use_point_ledger/);
 await assert.rejects(()=>db.query('DELETE FROM point_ledger WHERE user_id=$1',[user.id]),/immutable_record/);
 await assert.rejects(()=>credit(s,user.id,'too_much','-100'),/insufficient_points/);
});
test('self referral rejected; first referral survives subsequent start links',async()=>{
 const {s,user}=await fixture();await start(s.botId,1,123,`/start ref_${user.referral_code}`);
 assert.equal((await db.query('SELECT * FROM referrals WHERE bot_id=$1',[s.botId])).rows.length,0);
 await start(s.botId,2,456,`/start ref_${user.referral_code}`);
 await start(s.botId,3,789);
 const other=await one(db,'SELECT * FROM telegram_users WHERE bot_id=$1 AND telegram_user_id=789',[s.botId]);
 await start(s.botId,4,456,`/start ref_${other.referral_code}`);
 const referral=await one(db,'SELECT * FROM referrals WHERE bot_id=$1',[s.botId]);assert.equal(referral.inviter_id,user.id);
 await assert.rejects(()=>db.query('UPDATE referrals SET inviter_id=$1 WHERE id=$2',[other.id,referral.id]),/referral_binding_immutable/);
});
test('duplicate redemption debits once and failure refunds with a new ledger exactly once',async()=>{
 const {s,user}=await fixture();await credit(s,user.id);const r=await rule(s);
 const reserve=()=>db.transaction(tx=>reserveRedemption(tx,s,user.id,r.id,'order-key'));
 const [a,b]=await Promise.all([reserve(),reserve()]);assert.equal(a.id,b.id);
 assert.equal(String((await one(db,'SELECT balance FROM point_accounts WHERE user_id=$1',[user.id])).balance),'90');
 await db.transaction(tx=>failRedemption(tx,s,a.id,'test failure'));await db.transaction(tx=>failRedemption(tx,s,a.id,'test failure'));
 assert.equal(String((await one(db,'SELECT balance FROM point_accounts WHERE user_id=$1',[user.id])).balance),'100');
 assert.equal((await db.query('SELECT * FROM point_ledger WHERE user_id=$1',[user.id])).rows.length,3);
});
test('insufficient redemption balance rolls back order creation',async()=>{
 const {s,user}=await fixture();const r=await rule(s);
 await assert.rejects(()=>db.transaction(tx=>reserveRedemption(tx,s,user.id,r.id,'poor')),/insufficient_points/);
 assert.equal((await db.query('SELECT id FROM redemptions WHERE bot_id=$1',[s.botId])).rows.length,0);
});
test('one inventory code cannot be assigned to two simultaneous orders',async()=>{
 const {s,user}=await fixture();await credit(s,user.id);const r=await rule(s);
 const a=await db.transaction(tx=>reserveRedemption(tx,s,user.id,r.id,'a'));
 const b=await db.transaction(tx=>reserveRedemption(tx,s,user.id,r.id,'b'));
 await db.query('INSERT INTO redemption_codes(brand_id,bot_id,rule_id,code_secret_ref,code_fingerprint) VALUES($1,$2,$3,$4,$5)',[s.brandId,s.botId,r.id,randomUUID(),randomUUID()]);
 const results=await Promise.allSettled([db.transaction(tx=>assignCode(tx,s,a.id)),db.transaction(tx=>assignCode(tx,s,b.id))]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
 const assigned=await one(db,'SELECT redemption_id FROM redemption_codes WHERE bot_id=$1',[s.botId]);
 assert.ok([a.id,b.id].includes(assigned.redemption_id));
 await assert.rejects(()=>db.transaction(tx=>failRedemption(tx,s,assigned.redemption_id,'unsafe refund')),/manual_reconciliation/);
});
test('language and template fallback never inherit administrator Chinese locale',async()=>{
 const {s,bot,user}=await fixture();
 assert.equal(resolveLanguage({telegram_language_code:'zh-CN'},bot,{default_language:'pt-BR'}),'pt-BR');
 assert.equal(resolveLanguage({telegram_language_code:'es'},bot,{default_language:'pt-BR'}),'es-MX');
 assert.equal(resolveLanguage({preferred_language:'en',telegram_language_code:'es'},bot,{default_language:'pt-BR'}),'en');
 await db.query(`UPDATE telegram_users SET preferred_language='es-MX' WHERE id=$1`,[user.id]);
 await db.query(`INSERT INTO message_templates(brand_id,bot_id,template_key,language,body) VALUES($1,$2,'WELCOME','pt-BR','Olá!'),($1,$2,'HELP','zh-CN','后台中文')`,[s.brandId,s.botId]);
 assert.equal((await getTemplate(db,s,user.id,'WELCOME')).language,'pt-BR');
 await assert.rejects(()=>getTemplate(db,s,user.id,'HELP'),/template_missing/);
});
test('composite foreign keys and services reject cross-brand and cross-bot user access',async()=>{
 const a=await fixture(),b=await fixture();await assert.rejects(()=>credit(a.s,b.user.id));
 await assert.rejects(()=>db.query('INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id) VALUES($1,$2,999)',[a.s.brandId,b.s.botId]));
 // A second bot under the same brand remains isolated too.
 await db.query('UPDATE telegram_bots SET brand_id=$1 WHERE id=$2',[a.s.brandId,b.s.botId]).then(()=>assert.fail('FK must block moving an existing bot'),()=>{});
 await assert.rejects(()=>getTemplate(db,a.s,b.user.id,'WELCOME'),/not_found/);
});
test('same Telegram update and user IDs are independently accepted in separate bots',async()=>{
 const a=await fixture(),b=await fixture();await start(a.s.botId,55,987);await start(b.s.botId,55,987);
 assert.equal((await db.query('SELECT id FROM telegram_users WHERE telegram_user_id=987')).rows.length,2);
});
test('API denies viewer adjustment and wrong brand, permits scoped admin with atomic audit',async()=>{
 const {s,user}=await fixture(),other=await fixture();
 const admin=await one(db,`INSERT INTO admins(auth_subject,display_name) VALUES($1,'Tester') RETURNING id`,[randomUUID()]);
 await db.query(`INSERT INTO admin_roles(admin_id,role_id,brand_id,bot_id) SELECT $1,id,$2,$3 FROM roles WHERE name='Viewer'`,[admin.id,s.brandId,s.botId]);
 const app=createApp(db,()=> 'test-secret',async()=>({adminId:admin.id}));
 try {
  const url=`/v1/brands/${s.brandId}/bots/${s.botId}/points/adjustments`;
  const body={userId:user.id,delta:'20',eventId:randomUUID(),note:'test audit'};
  assert.equal((await app.inject({method:'POST',url,payload:body,headers:{'idempotency-key':'test-key'}})).statusCode,403);
  assert.equal((await app.inject({method:'GET',url:`/v1/brands/${other.s.brandId}/bots/${other.s.botId}/users`})).statusCode,403);
  await db.query(`INSERT INTO admin_roles(admin_id,role_id,brand_id,bot_id) SELECT $1,id,$2,$3 FROM roles WHERE name='Admin'`,[admin.id,s.brandId,s.botId]);
  for(let i=0;i<2;i++) {const res=await app.inject({method:'POST',url,payload:body,headers:{'idempotency-key':'test-key'}});assert.equal(res.statusCode,200,res.body);assert.equal(res.json().balance,'20');}
  assert.equal((await db.query('SELECT id FROM audit_logs WHERE bot_id=$1',[s.botId])).rows.length,1);
  const res=await app.inject({method:'GET',url:`/v1/brands/${s.brandId}/bots/${s.botId}/users`});assert.equal(res.statusCode,200);assert.ok(!res.body.includes('secret_ref'));
 } finally {await app.close();}
});

test('different bots in one brand cannot share accounts or referral targets',async()=>{
 const {s,user}=await fixture();
 const bot=await one(db,`INSERT INTO telegram_bots(brand_id,name,username,token_secret_ref,webhook_secret_ref,default_language,supported_languages) VALUES($1,'Sibling',$2,$3,$4,'en',ARRAY['en']) RETURNING id`,[s.brandId,randomUUID(),randomUUID(),randomUUID()]);
 const sibling={brandId:s.brandId,botId:bot.id};
 await assert.rejects(()=>credit(sibling,user.id));
 await assert.rejects(()=>db.query('INSERT INTO referrals(brand_id,bot_id,inviter_id,invitee_id,start_parameter) VALUES($1,$2,$3,$4,$5)',[s.brandId,bot.id,user.id,randomUUID(),'ref_test']));
});

test('restricted runtime role can process webhook and points but cannot write balance directly',async()=>{
 const {readFile}=await import('node:fs/promises');
 const {s,user}=await fixture();
 await db.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='telegram_app') THEN CREATE ROLE telegram_app NOLOGIN; END IF; END $$;`);
 await db.query(await readFile('db/runtime-grants.sql','utf8'));
 await db.transaction(async tx=>{
  await tx.query('SET LOCAL ROLE telegram_app');
  const ledger=await postPoints(tx,{...s,userId:user.id,delta:'12',source:'test',businessType:'role_test',businessId:randomUUID(),idempotencyKey:randomUUID()});
  assert.equal(String(ledger.balance_after),'12');
 });
 await assert.rejects(()=>db.transaction(async tx=>{await tx.query('SET LOCAL ROLE telegram_app');await tx.query('UPDATE point_accounts SET balance=1 WHERE user_id=$1',[user.id]);}),/permission denied/);
 const scoped:Database={
  query:(sql,params)=>db.transaction(async tx=>{await tx.query('SET LOCAL ROLE telegram_app');return tx.query(sql,params);}),
  transaction:fn=>db.transaction(async tx=>{await tx.query('SET LOCAL ROLE telegram_app');return fn(tx);})
 };
 await handleUpdate(scoped,s.botId,'test-secret',{update_id:42,message:{from:{id:123,first_name:'Changed'},text:'/start'}},()=> 'test-secret');
 assert.equal((await one(db,'SELECT first_name FROM telegram_users WHERE id=$1',[user.id])).first_name,'Changed');
});

test('database failure during user persistence rolls back the update receipt for safe retry',async()=>{
 const {s}=await fixture();
 const failing:Database={query:db.query.bind(db),transaction:fn=>db.transaction(tx=>fn({query:async(sql,params)=>{if(sql.includes('INSERT INTO telegram_users')) throw new Error('injected_failure');return tx.query(sql,params);}}))};
 const update={update_id:77,message:{from:{id:8181},text:'/start'}};
 await assert.rejects(()=>handleUpdate(failing,s.botId,'test-secret',update,()=> 'test-secret'),/injected_failure/);
 assert.equal((await db.query('SELECT * FROM telegram_updates WHERE bot_id=$1',[s.botId])).rows.length,0);
 assert.equal((await handleUpdate(db,s.botId,'test-secret',update,()=> 'test-secret')).duplicate,false);
});

test('default credential verifier denies missing or forged credentials',async()=>{
 const {credentialAuthenticator}=await import('../src/auth.js');
 const {createHash}=await import('node:crypto');const token=randomUUID()+randomUUID(),adminId=randomUUID();
 const auth=credentialAuthenticator(JSON.stringify({[createHash('sha256').update(token).digest('hex')]:adminId}));
 await assert.rejects(()=>auth(undefined),/unauthorized/);
 await assert.rejects(()=>auth(`Bearer ${randomUUID()}`),/unauthorized/);
 assert.equal((await auth(`Bearer ${token}`)).adminId,adminId);
});

test('SQL ON CONFLICT DO NOTHING cannot change a balance without inserting a ledger row',async()=>{
 const {s,user}=await fixture();const ledger=await credit(s,user.id);
 await db.query(`INSERT INTO point_ledger(brand_id,bot_id,user_id,account_id,delta,balance_before,balance_after,source,business_type,business_id,idempotency_key)
 SELECT brand_id,bot_id,user_id,account_id,delta,0,0,source,business_type,business_id,idempotency_key FROM point_ledger WHERE id=$1 ON CONFLICT DO NOTHING`,[ledger.id]);
 assert.equal(String((await one(db,'SELECT balance FROM point_accounts WHERE user_id=$1',[user.id])).balance),'100');
 assert.equal((await db.query('SELECT id FROM point_ledger WHERE user_id=$1',[user.id])).rows.length,1);
});
