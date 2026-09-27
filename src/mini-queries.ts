import {pointSummary,lotsEnabled} from './point-lots.js';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {one,type Database} from './db.js';
import {authenticateMini,type MiniAppBinding,type MiniPrincipal} from './mini-sessions.js';
import {binding,decodeCursor,encodeCursor} from './query-cursor.js';
const pageSchema=z.object({cursor:z.string().max(2048).optional(),limit:z.coerce.number().int().min(1).max(50).default(20)}).strict();
const noQuery=z.object({}).strict();
export function attachMiniQueries(app:FastifyInstance,db:Database,bindings:MiniAppBinding[]) {
 const auth=(req:any)=>authenticateMini(db,req.headers.authorization,bindings,req.headers.origin);
 const points=async(p:MiniPrincipal)=>{
  const summary=await pointSummary(db,p);
  return {accountExists:summary.accountExists,balance:summary.availableBalance,...(lotsEnabled()?{expiringSoon:summary.expiringSoon}:{})};
 };
 const activities=()=>({items:[],participationEnabled:false,catalogueStatus:'not_published'});
 app.get('/home',async req=>{
  noQuery.parse(req.query);const p=await auth(req);
  const profile=await one(db,`SELECT u.first_name,u.last_name,u.preferred_language,u.telegram_language_code,b.default_language AS bot_language,br.default_language AS project_language,b.name AS bot_name,br.name AS project_name
   FROM telegram_users u JOIN telegram_bots b ON (b.brand_id,b.id)=(u.brand_id,u.bot_id) JOIN brands br ON br.id=u.brand_id
   WHERE u.brand_id=$1 AND u.bot_id=$2 AND u.id=$3`,[p.brandId,p.botId,p.userId]);
  const totals=await one(db,`SELECT (SELECT count(*)::text FROM referrals WHERE brand_id=$1 AND bot_id=$2 AND inviter_id=$3) AS invited,
   (SELECT count(*)::text FROM redemptions WHERE brand_id=$1 AND bot_id=$2 AND user_id=$3) AS redemptions`,[p.brandId,p.botId,p.userId]);
  return {profile:{displayName:[profile.first_name,profile.last_name].filter(Boolean).join(' ')||'',projectName:profile.project_name,botName:profile.bot_name,uiLanguage:'zh-CN',preferredLanguage:profile.preferred_language,botLanguage:profile.bot_language,projectLanguage:profile.project_language,telegramLanguage:profile.telegram_language_code},points:await points(p),invitedCount:totals.invited,redemptionCount:totals.redemptions,activities:activities()};
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
