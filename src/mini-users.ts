import {DomainError,one,type Queryable,type Scope} from './db.js';
import type {MiniUser} from './telegram-init-data.js';
export async function mapMiniUser(tx:Queryable,scope:Scope,user:MiniUser) {
 // Caller holds the same Bot lock as webhook. Never fabricate /start or referrals.
 const existing=(await tx.query('SELECT status FROM telegram_users WHERE brand_id=$1 AND bot_id=$2 AND telegram_user_id=$3',
  [scope.brandId,scope.botId,String(user.id)])).rows[0];
 if(existing&&existing.status!=='active') throw new DomainError('mini_unauthorized',401);
 return one(tx,`INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id,username,first_name,last_name,telegram_language_code)
 VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(bot_id,telegram_user_id) DO UPDATE SET
 username=EXCLUDED.username,first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,
 telegram_language_code=EXCLUDED.telegram_language_code,last_interaction_at=now(),updated_at=now()
 WHERE telegram_users.status='active' RETURNING id`,
 [scope.brandId,scope.botId,String(user.id),user.username??null,user.first_name,user.last_name??null,user.language_code??null]);
}
