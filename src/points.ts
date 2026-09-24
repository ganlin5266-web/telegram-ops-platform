import {DomainError,one,scopeParams,type Queryable,type Scope} from './db.js';
export type PointEvent=Scope & {userId:string;delta:string;source:string;businessType:string;businessId:string;idempotencyKey:string;note?:string};
export async function postPoints(tx:Queryable,e:PointEvent) {
 if(!/^-?[1-9]\d*$/.test(e.delta) || BigInt(e.delta)>9223372036854775807n || BigInt(e.delta)<-9223372036854775808n) throw new DomainError('invalid_points',400);
 // Serialize by bot, also covering different users reusing the same event key.
 await one(tx,'SELECT id FROM telegram_bots WHERE brand_id=$1 AND id=$2 FOR UPDATE',scopeParams(e));
 const existing=(await tx.query('SELECT * FROM point_ledger WHERE bot_id=$1 AND (idempotency_key=$2 OR (business_type=$3 AND business_id=$4))',[e.botId,e.idempotencyKey,e.businessType,e.businessId])).rows[0];
 if(existing) {
  if(existing.user_id!==e.userId || String(existing.delta)!==e.delta || existing.business_type!==e.businessType || existing.business_id!==e.businessId || existing.source!==e.source) throw new DomainError('idempotency_conflict');
  return existing;
 }
 await tx.query('INSERT INTO point_accounts(brand_id,bot_id,user_id) VALUES($1,$2,$3) ON CONFLICT(bot_id,user_id) DO NOTHING',[...scopeParams(e),e.userId]);
 const account=await one(tx,'SELECT * FROM point_accounts WHERE brand_id=$1 AND bot_id=$2 AND user_id=$3 FOR UPDATE',[...scopeParams(e),e.userId]);
 if(BigInt(account.balance)+BigInt(e.delta)<0n) throw new DomainError('insufficient_points');
 return one(tx,`INSERT INTO point_ledger(brand_id,bot_id,user_id,account_id,delta,balance_before,balance_after,source,business_type,business_id,idempotency_key,note)
 VALUES($1,$2,$3,$4,$5,0,0,$6,$7,$8,$9,$10) RETURNING *`,[...scopeParams(e),e.userId,account.id,e.delta,e.source,e.businessType,e.businessId,e.idempotencyKey,e.note??'']);
}
