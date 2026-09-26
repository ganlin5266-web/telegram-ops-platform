import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomBytes,randomUUID} from 'node:crypto';
import {verifyInitData} from '../src/telegram-init-data.js';
import {miniConfig,validateMiniConfig} from '../src/mini-auth.js';
const secret=randomBytes(32).toString('hex'),now=1800000000;
// Independent signer uses URLSearchParams sorting, not the verifier implementation.
function sign(fields:Record<string,string>,key=secret) {
 const params=new URLSearchParams(fields);params.sort();
 const data=Array.from(params,([k,v])=>`${k}=${v}`).join('\n');
 const hmacKey=createHmac('sha256',Buffer.from('WebAppData')).update(key).digest();
 params.append('hash',createHmac('sha256',hmacKey).update(data).digest('hex'));return params.toString();
}
const fields={auth_date:String(now),query_id:'synthetic-query',user:JSON.stringify({id:9007199254740901,first_name:'测试 + & 😀',language_code:'zh-CN'})};
test('mini verifier: valid HMAC, Unicode, safe bigint identity and canonical replay digest',()=>{
 const raw=sign(fields);const first=verifyInitData(raw,secret,now);assert.equal(first.user.id,9007199254740901);
 assert.equal(first.user.first_name,'测试 + & 😀');
 assert.equal(verifyInitData(raw.split('&').reverse().join('&'),secret,now).payloadDigest,first.payloadDigest);
 assert.equal(verifyInitData(raw.replace(/%[a-f0-9]{2}/gi,s=>s.toLowerCase()),secret,now).payloadDigest,first.payloadDigest);
});
test('mini verifier: independently constructed WebCrypto HMAC agrees',async()=>{
 const {webcrypto}=await import('node:crypto');const enc=new TextEncoder();
 const p=new URLSearchParams(fields);p.sort();const data=Array.from(p,([k,v])=>`${k}=${v}`).join('\n');
 const key=await webcrypto.subtle.importKey('raw',enc.encode('WebAppData'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const derived=await webcrypto.subtle.sign('HMAC',key,enc.encode(secret));
 const second=await webcrypto.subtle.importKey('raw',derived,{name:'HMAC',hash:'SHA-256'},false,['sign']);
 p.append('hash',Buffer.from(await webcrypto.subtle.sign('HMAC',second,enc.encode(data))).toString('hex'));
 assert.equal(verifyInitData(p.toString(),secret,now).user.id,9007199254740901);
});
for(const [label,raw] of [
 ['tampered user',sign(fields).replace('zh-CN','en')],['duplicate hash',sign(fields)+'&hash='+'0'.repeat(64)],
 ['duplicate user',sign(fields)+'&user=%7B%7D'],['malformed encoding',sign(fields)+'&x=%GG'],
 ['missing hash',new URLSearchParams(fields).toString()],['short hash',sign(fields).replace(/hash=.*/,'hash=abc')],
 ['missing user',sign({auth_date:String(now)})],['unsafe ID',sign({...fields,user:JSON.stringify({id:9007199254740992,first_name:'X'})})],
 ['negative ID',sign({...fields,user:JSON.stringify({id:-1,first_name:'X'})})],['bot user',sign({...fields,user:JSON.stringify({id:1,first_name:'X',is_bot:true})})],
 ['missing first name',sign({...fields,user:'{"id":1}'})],['invalid date',sign({...fields,auth_date:'not-date'})],
 ['expired',sign({...fields,auth_date:String(now-300)})],['future',sign({...fields,auth_date:String(now+31)})],
 ['oversized',sign(fields)+'&x='+'a'.repeat(16384)],['newline ambiguity',sign({...fields,query_id:'x\nauth_date=123'})],
] as const) test(`mini verifier rejects ${label}`,()=>assert.throws(()=>verifyInitData(raw,secret,now),/mini_invalid_identity/));
test('mini verifier rejects wrong Bot secret and empty secret',()=>{
 assert.throws(()=>verifyInitData(sign(fields),'wrong',now));assert.throws(()=>verifyInitData(sign(fields),'',now));
});
test('mini verifier freshness boundaries and optional signature HMAC coverage',()=>{
 verifyInitData(sign({...fields,auth_date:String(now-299)}),secret,now);
 verifyInitData(sign({...fields,auth_date:String(now+30)}),secret,now);
 verifyInitData(sign({...fields,signature:'synthetic-signature'}),secret,now);
 assert.throws(()=>verifyInitData(sign({...fields,signature:'synthetic-signature'}).replace('synthetic-signature','changed'),secret,now));
});
test('mini config disabled by default; enabled config fails closed with generic error',()=>{
 assert.equal(miniConfig({}),undefined);assert.equal(miniConfig({MINI_AUTH_ENABLED:'false',MINI_APPS_JSON:'bad'}),undefined);
 for(const env of [{MINI_AUTH_ENABLED:'yes'},{MINI_AUTH_ENABLED:'true'},{MINI_AUTH_ENABLED:'true',MINI_APPS_JSON:'secret-canary'}])
  assert.throws(()=>miniConfig(env),e=>e instanceof Error&&e.message==='Invalid Mini App configuration');
 const binding={appKey:'sample',botId:randomUUID(),origin:'https://mini.example.test',tokenSecretRef:'SYNTHETIC_TOKEN_REF'};
 validateMiniConfig({bindings:[binding]});
 for(const origin of ['http://mini.example.test','https://mini.example.test/','https://*.example.test','null','https://u:p@mini.example.test','https://mini.example.test?q=x'])
  assert.throws(()=>validateMiniConfig({bindings:[{...binding,origin}]}));
 assert.throws(()=>validateMiniConfig({bindings:[binding,binding]}));
 assert.throws(()=>validateMiniConfig({bindings:[]}));
});
