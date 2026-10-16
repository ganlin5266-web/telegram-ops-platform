import {createHash} from 'node:crypto';
import {z} from 'zod';
import {authorize,type Principal} from './auth.js';
import {DomainError,one,type Database,type Scope} from './db.js';
import type {RedemptionCodeVault} from './redemption-vault.js';

const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const decimal=z.string().regex(/^\d+(?:\.\d{1,8})?$/);

export const ruleInput=z.object({
 platformId:z.uuid(),
 tierKey:z.string().trim().regex(/^[a-z0-9_-]{1,64}$/),
 name:z.string().trim().min(1).max(120),
 pointsCost:z.number().int().min(1).max(300),
 faceValue:decimal,
 currency:z.string().regex(/^[A-Z]{3}$/),
 effectiveFrom:date,
 effectiveUntil:date.nullable().default(null)
}).strict();

export const batchInput=z.object({
 ruleId:z.uuid(),
 codes:z.array(z.object({
  code:z.string().regex(/^[\x21-\x7e]{4,160}$/),
  expiresAt:z.iso.datetime().nullable().default(null)
 }).strict()).min(1).max(500)
}).strict();

export async function createRedemptionRule(
 db:Database,p:Principal,s:Scope,input:unknown,requestId:string
) {
 const v=ruleInput.parse(input);
 return db.transaction(async tx=>{
  await authorize(tx,p,s,'redemptions.rules.manage');
  const platform=await one(tx,
   "SELECT currency FROM platforms WHERE brand_id=$1 AND id=$2 AND status='active' FOR UPDATE",
   [s.brandId,v.platformId]
  );
  if(platform.currency!==v.currency) throw new DomainError('redemption_currency_mismatch');
  if(v.effectiveUntil&&v.effectiveUntil<v.effectiveFrom)
   throw new DomainError('invalid_effective_window',400);
  const version=Number((await one(tx,
   'SELECT coalesce(max(version),0)+1 AS n FROM redemption_rules WHERE brand_id=$1 AND platform_id=$2 AND tier_key=$3',
   [s.brandId,v.platformId,v.tierKey]
  )).n);
  const row=await one(tx,`INSERT INTO redemption_rules(
   brand_id,bot_id,platform_id,tier_key,version,status,name,mode,points_cost,
   exchange_rate,daily_count_limit,daily_points_limit,requires_deposit,review_mode,
   enabled,conditions,face_value,face_currency,effective_from,effective_until,created_by
  ) VALUES($1,$2,$3,$4,$5,'draft',$6,'fixed',$7,1,1,300,false,'automatic',
   false,'{}',$8,$9,$10,$11,$12)
   RETURNING id,version,status`,
   [s.brandId,s.botId,v.platformId,v.tierKey,version,v.name,v.pointsCost,
    v.faceValue,v.currency,v.effectiveFrom,v.effectiveUntil,p.adminId]
  );
  await tx.query(`INSERT INTO audit_logs(
   admin_id,brand_id,bot_id,action,object_type,object_id,request_id,after_data
  ) VALUES($1,$2,$3,'redemption.rule.create','redemption_rule',$4,$5,$6)`,
   [p.adminId,s.brandId,s.botId,row.id,requestId,JSON.stringify(v)]
  );
  return row;
 });
}

export async function changeRedemptionRule(
 db:Database,p:Principal,s:Scope,id:string,action:'publish'|'disable',requestId:string
) {
 return db.transaction(async tx=>{
  await authorize(tx,p,s,'redemptions.rules.manage');
  const row=await one(tx,
   'SELECT * FROM redemption_rules WHERE brand_id=$1 AND bot_id=$2 AND id=$3 FOR UPDATE',
   [s.brandId,s.botId,id]
  );
  if(row.platform_id===null) throw new DomainError('legacy_rule_not_supported');
  if(action==='publish') {
   if(row.status==='published') return {id,status:'published'};
   if(row.status!=='draft') throw new DomainError('invalid_rule_state');
   await tx.query(
    "UPDATE redemption_rules SET status='published',enabled=true,published_by=$2,published_at=now() WHERE id=$1",
    [id,p.adminId]
   );
  } else {
   if(row.status==='disabled') return {id,status:'disabled'};
   if(row.status!=='published') throw new DomainError('invalid_rule_state');
   await tx.query(
    "UPDATE redemption_rules SET status='disabled',enabled=false,disabled_by=$2,disabled_at=now() WHERE id=$1",
    [id,p.adminId]
   );
  }
  await tx.query(`INSERT INTO audit_logs(
   admin_id,brand_id,bot_id,action,object_type,object_id,request_id
  ) VALUES($1,$2,$3,$4,'redemption_rule',$5,$6)`,
   [p.adminId,s.brandId,s.botId,`redemption.rule.${action}`,id,requestId]
  );
  return {id,status:action==='publish'?'published':'disabled'};
 });
}

export async function importCodeBatch(
 db:Database,vault:RedemptionCodeVault|undefined,p:Principal,s:Scope,input:unknown,requestId:string
) {
 if(!vault) throw new DomainError('redemption_vault_unavailable',503);
 const v=batchInput.parse(input);
 return db.transaction(async tx=>{
  await authorize(tx,p,s,'redemptions.inventory.manage');
  const rule=await one(tx,`SELECT r.*
   FROM redemption_rules r
   JOIN platforms p ON (p.brand_id,p.id)=(r.brand_id,r.platform_id)
   WHERE r.brand_id=$1 AND r.bot_id=$2 AND r.id=$3 AND r.status='published'
   FOR UPDATE OF p,r`,[s.brandId,s.botId,v.ruleId]);

  const rows=v.codes.map(c=>({...c,...vault.encrypt(c.code,rule.platform_id)}));
  const source=createHash('sha256')
   .update(rows.map(r=>r.fingerprint).sort().join('\n'))
   .digest('hex');
  const prior=(await tx.query(`SELECT id,status,total_count,imported_count,duplicate_count
   FROM redemption_code_batches
   WHERE brand_id=$1 AND bot_id=$2 AND platform_id=$3 AND source_fingerprint=$4`,
   [s.brandId,s.botId,rule.platform_id,source])).rows[0];
  if(prior) return prior;

  const counts=new Map<string,number>();
  for(const row of rows) counts.set(row.fingerprint,(counts.get(row.fingerprint)??0)+1);
  const existing=new Set((await tx.query<{code_fingerprint:string}>(
   'SELECT code_fingerprint FROM redemption_codes WHERE brand_id=$1 AND platform_id=$2 AND code_fingerprint=ANY($3::text[])',
   [s.brandId,rule.platform_id,[...counts.keys()]]
  )).rows.map(r=>r.code_fingerprint));
  const duplicateCount=rows.filter(r=>(counts.get(r.fingerprint)??0)>1||existing.has(r.fingerprint)).length;

  const status=duplicateCount?'rejected':'imported';
  const batch=await one(tx,`INSERT INTO redemption_code_batches(
   brand_id,bot_id,platform_id,rule_id,status,total_count,imported_count,
   duplicate_count,source_fingerprint,created_by,request_id
  ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
   RETURNING id,status,total_count,imported_count,duplicate_count`,
   [s.brandId,s.botId,rule.platform_id,rule.id,status,rows.length,
    duplicateCount?0:rows.length,duplicateCount,source,p.adminId,requestId]
  );

  if(!duplicateCount) {
   for(const r of rows) {
    await tx.query(`INSERT INTO redemption_codes(
     brand_id,bot_id,platform_id,rule_id,batch_id,code_secret_ref,code_fingerprint,
     code_ciphertext,code_iv,code_auth_tag,code_key_version,expires_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
     [s.brandId,s.botId,rule.platform_id,rule.id,batch.id,
      `encrypted:${batch.id}:${r.fingerprint.slice(0,16)}`,r.fingerprint,
      r.ciphertext,r.iv,r.authTag,r.keyVersion,r.expiresAt]
    );
   }
  }

  await tx.query(`INSERT INTO audit_logs(
   admin_id,brand_id,bot_id,action,object_type,object_id,request_id,after_data
  ) VALUES($1,$2,$3,$4,'redemption_code_batch',$5,$6,$7)`,
   [p.adminId,s.brandId,s.botId,
    duplicateCount?'redemption.inventory.import_rejected':'redemption.inventory.import',
    batch.id,requestId,JSON.stringify({
     ruleId:rule.id,totalCount:rows.length,
     importedCount:duplicateCount?0:rows.length,duplicateCount
    })]
  );
  return batch;
 });
}
