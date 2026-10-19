import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {authorize,type Principal} from './auth.js';
import {DomainError,one,type Database} from './db.js';
import type {RedemptionCodeVault} from './redemption-vault.js';
import {
 batchInput,changeRedemptionRule,createRedemptionRule,importCodeBatch,ruleInput
} from './redemption-v2.js';
import {listAdminRedemptions,reviewRedemption} from './redemption-flow.js';

const scope=z.object({brandId:z.uuid(),botId:z.uuid()});
const none=z.object({}).strict();
const emptyBody=z.union([z.undefined(),none]);

export function attachAdminRedemptions(
 app:FastifyInstance,
 db:Database,
 auth:(request:FastifyRequest)=>Promise<Principal>,
 vault?:RedemptionCodeVault
) {
 const base='/v1/brands/:brandId/bots/:botId';

 app.get(base+'/redemption-rules',async request=>{
  none.parse(request.query);
  const s=scope.parse(request.params),p=await auth(request);
  await authorize(db,p,s,'redemptions.read');
  return {items:(await db.query(`SELECT
   id,platform_id,tier_key,version,status,name,points_cost::text,
   face_value::text,face_currency,effective_from::text,effective_until::text,enabled
   FROM redemption_rules
   WHERE brand_id=$1 AND bot_id=$2 AND platform_id IS NOT NULL
   ORDER BY platform_id,tier_key,version DESC`,[s.brandId,s.botId])).rows};
 });

 app.post(base+'/redemption-rules/preview',async request=>{
  none.parse(request.query);
  const s=scope.parse(request.params),p=await auth(request),v=ruleInput.parse(request.body);
  await authorize(db,p,s,'redemptions.rules.manage');
  const platform=await one(db,
   "SELECT currency,timezone FROM platforms WHERE brand_id=$1 AND id=$2 AND status='active'",
   [s.brandId,v.platformId]
  );
  if(platform.currency!==v.currency) {
   throw new DomainError('redemption_currency_mismatch');
  }
  return {readonly:true,writes:0,rule:{
   ...v,mode:'fixed',dailyCountLimit:1,dailyPointsLimit:300,
   requiresDeposit:false,timezone:platform.timezone
  }};
 });

 app.post(base+'/redemption-rules',async request=>{
  none.parse(request.query);
  return createRedemptionRule(
   db,await auth(request),scope.parse(request.params),request.body,request.id
  );
 });

 app.post(base+'/redemption-rules/:id/publish',async request=>{
  none.parse(request.query);emptyBody.parse(request.body);
  const s=scope.extend({id:z.uuid()}).parse(request.params);
  return changeRedemptionRule(db,await auth(request),s,s.id,'publish',request.id);
 });

 app.post(base+'/redemption-rules/:id/disable',async request=>{
  none.parse(request.query);emptyBody.parse(request.body);
  const s=scope.extend({id:z.uuid()}).parse(request.params);
  return changeRedemptionRule(db,await auth(request),s,s.id,'disable',request.id);
 });

 app.post(base+'/redemption-code-batches',{bodyLimit:262144},async request=>{
  none.parse(request.query);
  batchInput.parse(request.body);
  return importCodeBatch(
   db,vault,await auth(request),scope.parse(request.params),request.body,request.id
  );
 });

 app.get(base+'/redemption-code-batches',async request=>{
  none.parse(request.query);
  const s=scope.parse(request.params),p=await auth(request);
  await authorize(db,p,s,'redemptions.read');
  return {items:(await db.query(`SELECT
   id,platform_id,rule_id,status,total_count,imported_count,duplicate_count,
   created_by,created_at
   FROM redemption_code_batches
   WHERE brand_id=$1 AND bot_id=$2
   ORDER BY created_at DESC,id DESC LIMIT 100`,[s.brandId,s.botId])).rows};
 });

 app.get(base+'/redemption-inventory',async request=>{
  none.parse(request.query);
  const s=scope.parse(request.params),p=await auth(request);
  await authorize(db,p,s,'redemptions.read');
  return {items:(await db.query(`SELECT
   platform_id,rule_id,count(*)::int AS total,
   count(*) FILTER(
    WHERE status='available' AND (expires_at IS NULL OR expires_at>now())
   )::int AS available,
   count(*) FILTER(
    WHERE status='available' AND expires_at<=now()
   )::int AS expired,
   count(*) FILTER(WHERE status='disabled')::int AS disabled,
   count(*) FILTER(WHERE status='assigned')::int AS assigned,
   count(*) FILTER(WHERE status='used')::int AS claimed
   FROM redemption_codes
   WHERE brand_id=$1 AND bot_id=$2 AND platform_id IS NOT NULL
   GROUP BY platform_id,rule_id
   ORDER BY platform_id,rule_id`,[s.brandId,s.botId])).rows};
 });

 app.post(base+'/redemption-codes/:id/disable',async request=>{
  none.parse(request.query);emptyBody.parse(request.body);
  const s=scope.extend({id:z.uuid()}).parse(request.params),p=await auth(request);
  return db.transaction(async tx=>{
   await authorize(tx,p,s,'redemptions.inventory.manage');
   const row=await one(tx,`SELECT id FROM redemption_codes
    WHERE brand_id=$1 AND bot_id=$2 AND id=$3 AND status='available'
    FOR UPDATE`,[s.brandId,s.botId,s.id]);
   await tx.query("UPDATE redemption_codes SET status='disabled' WHERE id=$1",[row.id]);
   await tx.query(`INSERT INTO audit_logs(
    admin_id,brand_id,bot_id,action,object_type,object_id,request_id
   ) VALUES($1,$2,$3,'redemption.inventory.disable','redemption_code',$4,$5)`,
    [p.adminId,s.brandId,s.botId,row.id,request.id]
   );
   return {ok:true};
  });
 });

 app.get(base+'/redemptions',async request=>{
  none.parse(request.query);
  return listAdminRedemptions(db,await auth(request),scope.parse(request.params));
 });

 app.post(base+'/redemptions/:id/review',async request=>{
  none.parse(request.query);
  const s=scope.extend({id:z.uuid()}).parse(request.params);
  const body=z.object({
   action:z.enum(['mark_review','refund']),
   reason:z.enum(['platform_rejected','user_reported_code_issue','internal_failure_unknown','confirmed_internal_failure'])
  }).strict().parse(request.body);
  return reviewRedemption(db,await auth(request),s,s.id,body.action,body.reason,request.id);
 });
}
