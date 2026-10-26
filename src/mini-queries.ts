import {miniMemberSummary} from './member-growth.js';
import {pointSummary,lotsEnabled} from './point-lots.js';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {DomainError,one,type Database} from './db.js';
import {authenticateMini,type MiniAppBinding,type MiniPrincipal} from './mini-sessions.js';
import {binding,decodeCursor,encodeCursor} from './query-cursor.js';
const pageSchema=z.object({cursor:z.string().max(2048).optional(),limit:z.coerce.number().int().min(1).max(50).default(20)}).strict();
const noQuery=z.object({}).strict();
export function telegramReferralDeepLink(username:unknown,code:unknown) {
 const bot=String(username??'').replace(/^@/,'');const referral=String(code??'');
 if(!/^[A-Za-z0-9_]{1,64}$/.test(bot)||!/^[A-Za-z0-9_-]{1,60}$/.test(referral)) return null;
 return `https://t.me/${bot}?start=ref_${referral}`;
}
export function attachMiniQueries(app:FastifyInstance,db:Database,bindings:MiniAppBinding[]) {
 const auth=(req:any)=>authenticateMini(db,req.headers.authorization,bindings,req.headers.origin);
 const points=async(p:MiniPrincipal)=>{
  try {
   const summary=await pointSummary(db,p);
   return {accountExists:summary.accountExists,balance:summary.availableBalance,...(lotsEnabled()?{expiringSoon:summary.expiringSoon}:{})};
  } catch(error) {
   // A new Bot can authenticate before Points is configured. Never manufacture
   // a zero balance or suppress a missing cutover for an existing account.
   if(error instanceof DomainError&&error.code==='point_lot_cutover_required'&&
    !(await db.query('SELECT id FROM point_accounts WHERE brand_id=$1 AND bot_id=$2 AND user_id=$3',[p.brandId,p.botId,p.userId])).rows.length)
    return {accountExists:false,balance:null};
   throw error;
  }
 };
 const member=async(p:MiniPrincipal)=>{
  try {return await miniMemberSummary(db,p);}
  catch(error) {
   // Missing local rules must not turn successful login into a failed home.
   // miniMemberSummary has rolled back; no rules, member or balances are created.
   if(error instanceof DomainError&&error.code==='member_rule_not_available') return {enabled:true,available:false};
   throw error;
  }
 };
 const activities=()=>({items:[],participationEnabled:false,catalogueStatus:'not_published'});
 app.get('/home',async req=>{
  noQuery.parse(req.query);const p=await auth(req);
  const profile=await one(db,`SELECT u.first_name,u.last_name,u.preferred_language,u.telegram_language_code,u.referral_code,
   b.default_language AS bot_language,b.name AS bot_name,b.username AS bot_username,
   br.default_language AS project_language,br.name AS project_name
   FROM telegram_users u JOIN telegram_bots b ON (b.brand_id,b.id)=(u.brand_id,u.bot_id) JOIN brands br ON br.id=u.brand_id
   WHERE u.brand_id=$1 AND u.bot_id=$2 AND u.id=$3`,[p.brandId,p.botId,p.userId]);
  const totals=await one(db,`SELECT (SELECT count(*)::text FROM referrals WHERE brand_id=$1 AND bot_id=$2 AND inviter_id=$3) AS invited,
   (SELECT count(*)::text FROM redemptions WHERE brand_id=$1 AND bot_id=$2 AND user_id=$3) AS redemptions`,[p.brandId,p.botId,p.userId]);
  const referral=await one(db,`SELECT
   (SELECT count(DISTINCT q.referral_id)::text FROM referral_qualification_evidence q
     JOIN referrals r ON (r.brand_id,r.bot_id,r.id)=(q.brand_id,q.bot_id,q.referral_id)
    WHERE r.brand_id=$1 AND r.bot_id=$2 AND r.inviter_id=$3 AND q.status IN ('verified','cap_exceeded')) AS qualified_total,
   (SELECT count(DISTINCT q.referral_id)::text FROM referral_qualification_evidence q
     JOIN referrals r ON (r.brand_id,r.bot_id,r.id)=(q.brand_id,q.bot_id,q.referral_id)
     JOIN platforms platform ON (platform.brand_id,platform.id)=(q.brand_id,q.platform_id)
    WHERE r.brand_id=$1 AND r.bot_id=$2 AND r.inviter_id=$3 AND q.status IN ('verified','cap_exceeded')
      AND q.business_date=(clock_timestamp() AT TIME ZONE platform.timezone)::date) AS qualified_today,
   (SELECT coalesce(sum(points),0)::text FROM referral_reward_events
    WHERE brand_id=$1 AND bot_id=$2 AND recipient_user_id=$3 AND status='granted') AS points_earned`,
   [p.brandId,p.botId,p.userId]);
  const shareUrl=telegramReferralDeepLink(profile.bot_username,profile.referral_code);
  return {member:await member(p),profile:{displayName:[profile.first_name,profile.last_name].filter(Boolean).join(' ')||'',projectName:profile.project_name,botName:profile.bot_name,uiLanguage:'zh-CN',preferredLanguage:profile.preferred_language,botLanguage:profile.bot_language,projectLanguage:profile.project_language,telegramLanguage:profile.telegram_language_code},points:await points(p),invitedCount:totals.invited,redemptionCount:totals.redemptions,activities:activities(),referral:{qualifiedToday:referral.qualified_today,qualifiedTotal:referral.qualified_total,pointsEarned:referral.points_earned,shareUrl}};
 });
 app.get('/points',async req=>{noQuery.parse(req.query);return points(await auth(req));});
 app.get('/activities',async req=>{noQuery.parse(req.query);await auth(req);return activities();});
 // Operational activity configs have no public publishing/audience contract yet.
 // Never leak drafts/rules or pretend users can participate.
 for(const kind of ['point-ledger','referrals','redemptions'] as const) {
  app.get('/'+kind,async req=>{
   const q=pageSchema.parse(req.query),p=await auth(req);
   const ctx=binding(['mini-v1',kind,p.brandId,p.botId,p.userId]);
   const cursor=q.cursor?decodeCursor(q.cursor,ctx):undefined;
   const fields=kind==='point-ledger'?'id,created_at,delta::text,source,business_type':kind==='referrals'?'id,bound_at AS created_at,status,reward_status':'id,created_at,points_cost::text,status';
   const table=kind==='point-ledger'?'point_ledger':kind;
   const owner=kind==='referrals'?'inviter_id':'user_id';
   const date=kind==='referrals'?'bound_at':'created_at';
   const rows=(await db.query(`SELECT ${fields} FROM ${table} WHERE brand_id=$1 AND bot_id=$2 AND ${owner}=$3
    AND ($4::timestamptz IS NULL OR (${date},id)<($4::timestamptz,$5::uuid)) ORDER BY ${date} DESC,id DESC LIMIT $6`,
    [p.brandId,p.botId,p.userId,cursor?.value??null,cursor?.id??null,q.limit+1])).rows;
   const more=rows.length>q.limit,items=rows.slice(0,q.limit).map(r=>({...r,id:String(r.id),created_at:new Date(r.created_at).toISOString()}));const last=items.at(-1);
   return {items,nextCursor:more&&last?encodeCursor(ctx,String(last.id),last.created_at):null};
  });
 }
}
