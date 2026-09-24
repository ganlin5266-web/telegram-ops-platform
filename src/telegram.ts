import {z} from 'zod';
import {timingSafeEqual} from 'node:crypto';
import {DomainError,one,type Database} from './db.js';
const actor=z.object({id:z.number().int().positive().safe(),is_bot:z.boolean().optional(),username:z.string().optional(),first_name:z.string().optional(),last_name:z.string().optional(),language_code:z.string().optional()});
const message=z.object({from:actor.optional(),text:z.string().optional()}).passthrough();
export const updateSchema=z.object({update_id:z.number().int().nonnegative().safe(),message:message.optional(),edited_message:message.optional(),callback_query:z.object({from:actor,data:z.string().optional()}).passthrough().optional(),my_chat_member:z.object({from:actor}).passthrough().optional(),chat_member:z.object({from:actor}).passthrough().optional(),channel_post:z.record(z.string(),z.unknown()).optional()}).passthrough();
export type SecretProvider=(ref:string)=>string|undefined;
export function verifySecret(expected:string|undefined,actual:string|undefined) {
 if(!expected||!actual) return false; const a=Buffer.from(expected),b=Buffer.from(actual);
 return a.length===b.length&&timingSafeEqual(a,b);
}
export async function handleUpdate(db:Database,botId:string,header:string|undefined,raw:unknown,secrets:SecretProvider) {
 const bot=await one(db,`SELECT b.* FROM telegram_bots b JOIN brands br ON br.id=b.brand_id WHERE b.id=$1 AND b.status='active' AND br.status='active'`,[botId]);
 if(!verifySecret(secrets(bot.webhook_secret_ref),header)) throw new DomainError('unauthorized',401);
 const update=updateSchema.parse(raw);
 return db.transaction(async tx=>{
  // Uniform lock ordering across webhook/points/redemption services.
  await one(tx,'SELECT id FROM telegram_bots WHERE id=$1 FOR UPDATE',[botId]);
  const kind=['message','edited_message','callback_query','my_chat_member','chat_member','channel_post'].find(k=>k in update)??'unsupported';
  const inserted=(await tx.query(`INSERT INTO telegram_updates(brand_id,bot_id,update_id,kind,status) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING update_id`,[bot.brand_id,botId,String(update.update_id),kind,kind==='unsupported'?'ignored':'processed'])).rows[0];
  if(!inserted) return {ok:true,duplicate:true};
  const from=update.message?.from??update.edited_message?.from??update.callback_query?.from;
  if(from&&!from.is_bot) {
   const start=update.message?.text?.match(/^\/start(?:@([A-Za-z0-9_]+))?(?:\s+([A-Za-z0-9_-]{1,64}))?\s*$/);
   const isStart=!!start&&(!start[1]||start[1].toLowerCase()===bot.username.toLowerCase());
   const user=await one(tx,`INSERT INTO telegram_users(brand_id,bot_id,telegram_user_id,username,first_name,last_name,telegram_language_code,first_started_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $8 THEN now() ELSE NULL END)
    ON CONFLICT(bot_id,telegram_user_id) DO UPDATE SET username=EXCLUDED.username,first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,
    telegram_language_code=EXCLUDED.telegram_language_code,first_started_at=COALESCE(telegram_users.first_started_at,EXCLUDED.first_started_at),last_interaction_at=now(),updated_at=now() RETURNING *`,
    [bot.brand_id,botId,String(from.id),from.username??null,from.first_name??null,from.last_name??null,from.language_code??null,isStart]);
   const parameter=isStart?start?.[2]:undefined;
   if(parameter?.startsWith('ref_')) {
    const inviter=(await tx.query('SELECT id FROM telegram_users WHERE brand_id=$1 AND bot_id=$2 AND referral_code=$3',[bot.brand_id,botId,parameter.slice(4)])).rows[0];
    if(inviter&&inviter.id!==user.id) await tx.query(`INSERT INTO referrals(brand_id,bot_id,inviter_id,invitee_id,start_parameter) VALUES($1,$2,$3,$4,$5) ON CONFLICT(bot_id,invitee_id) DO NOTHING`,[bot.brand_id,botId,inviter.id,user.id,parameter]);
   }
  }
  return {ok:true,duplicate:false};
 });
}
