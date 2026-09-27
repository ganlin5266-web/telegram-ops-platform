import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {attachAdminPlatforms} from '../src/platform-routes.js';
import type {Database} from '../src/db.js';
const brand='11111111-1111-4111-8111-111111111111', bot='22222222-2222-4222-8222-222222222222',user='33333333-3333-4333-8333-333333333333';
test('user360 identity filter is parameterized, scope-bound, read-only and permission gated',async()=>{
 const calls:{sql:string;params:unknown[]}[]=[];let allow=true;
 const db={query:async(sql:string,params:unknown[])=>{calls.push({sql,params});assert.match(sql.trim(),/^SELECT/);if(sql.includes('FROM telegram_bots'))return {rows:[{id:bot}]};if(sql.includes('FROM admins'))return {rows:allow?[{id:user}]:[]};return {rows:[]};}} as unknown as Database;
 const app=Fastify();app.setErrorHandler((e:any,_r,reply)=>reply.code(e.status||400).send({error:e.code||'invalid'}));attachAdminPlatforms(app,db,async()=>({adminId:user}));
 const path=`/v1/brands/${brand}/bots/${bot}/platform-identities`;
 let r=await app.inject({url:`${path}?userId=${user}`});assert.equal(r.statusCode,200);assert.deepEqual(r.json(),{items:[],nextCursor:null});
 const q=calls.find(c=>c.sql.includes('FROM platform_identities'))!;assert.deepEqual(q.params.slice(0,3),[brand,bot,user]);assert.match(q.sql,/i.brand_id=\$1 AND i.bot_id=\$2/);
 r=await app.inject({url:`${path}?userId=invalid`});assert.equal(r.statusCode,400);
 calls.length=0;allow=false;r=await app.inject({url:`${path}?userId=${user}`});assert.notEqual(r.statusCode,200);assert.equal(calls.some(c=>c.sql.includes('FROM platform_identities')),false);
 await app.close();
});
