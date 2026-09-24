import {DomainError,one,scopeParams,type Queryable,type Scope} from './db.js';
import {postPoints} from './points.js';
// Internal transactional primitives only. No public redemption endpoint in phase one.
export async function reserveRedemption(tx:Queryable,s:Scope,userId:string,ruleId:string,key:string) {
 await one(tx,'SELECT id FROM telegram_bots WHERE brand_id=$1 AND id=$2 FOR UPDATE',scopeParams(s));
 const previous=(await tx.query('SELECT * FROM redemptions WHERE brand_id=$1 AND bot_id=$2 AND idempotency_key=$3',[...scopeParams(s),key])).rows[0];
 if(previous) {if(previous.user_id!==userId||previous.rule_id!==ruleId) throw new DomainError('idempotency_conflict');return previous;}
 const rule=await one(tx,'SELECT * FROM redemption_rules WHERE brand_id=$1 AND bot_id=$2 AND id=$3 FOR UPDATE',[...scopeParams(s),ruleId]);
 if(!rule.enabled) throw new DomainError('rule_disabled');
 // Fail closed for rules whose policy engine is not implemented in phase one.
 if(rule.mode!=='fixed'||rule.requires_deposit||rule.daily_count_limit||rule.daily_points_limit||Object.keys(rule.conditions).length) throw new DomainError('rule_policy_not_implemented');
 const order=await one(tx,`INSERT INTO redemptions(brand_id,bot_id,user_id,rule_id,points_cost,idempotency_key,rule_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[...scopeParams(s),userId,ruleId,String(rule.points_cost),key,JSON.stringify(rule)]);
 await postPoints(tx,{...s,userId,delta:`-${rule.points_cost}`,source:'redemption',businessType:'redemption_debit',businessId:order.id,idempotencyKey:`redeem:${order.id}`});
 return order;
}
export async function assignCode(tx:Queryable,s:Scope,orderId:string) {
 const order=await one(tx,'SELECT * FROM redemptions WHERE brand_id=$1 AND bot_id=$2 AND id=$3 FOR UPDATE',[...scopeParams(s),orderId]);
 const assigned=(await tx.query('SELECT id FROM redemption_codes WHERE brand_id=$1 AND bot_id=$2 AND redemption_id=$3',[...scopeParams(s),orderId])).rows[0];
 if(assigned) return assigned;
 if(!['pending','processing'].includes(order.status)) throw new DomainError('invalid_order_state');
 const code=(await tx.query(`SELECT id FROM redemption_codes WHERE brand_id=$1 AND bot_id=$2 AND rule_id=$3 AND status='available' AND (expires_at IS NULL OR expires_at>now()) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,[...scopeParams(s),order.rule_id])).rows[0];
 if(!code) throw new DomainError('inventory_empty');
 await tx.query(`UPDATE redemptions SET status='processing',updated_at=now() WHERE id=$1`,[orderId]);
 return one(tx,`UPDATE redemption_codes SET redemption_id=$1,status='assigned',assigned_at=now() WHERE id=$2 RETURNING id`,[orderId,code.id]);
}
export async function failRedemption(tx:Queryable,s:Scope,orderId:string,reason:string) {
 await one(tx,'SELECT id FROM telegram_bots WHERE brand_id=$1 AND id=$2 FOR UPDATE',scopeParams(s));
 const order=await one(tx,'SELECT * FROM redemptions WHERE brand_id=$1 AND bot_id=$2 AND id=$3 FOR UPDATE',[...scopeParams(s),orderId]);
 if(order.status==='failed') return order;
 if(!['pending','processing'].includes(order.status)) throw new DomainError('invalid_order_state');
 if((await tx.query('SELECT id FROM redemption_codes WHERE redemption_id=$1',[orderId])).rows.length) throw new DomainError('assigned_code_requires_manual_reconciliation');
 await postPoints(tx,{...s,userId:order.user_id,delta:String(order.points_cost),source:'redemption',businessType:'redemption_refund',businessId:order.id,idempotencyKey:`refund:${order.id}`,note:reason});
 return one(tx,`UPDATE redemptions SET status='failed',failure_reason=$2,updated_at=now() WHERE id=$1 RETURNING *`,[orderId,reason]);
}
