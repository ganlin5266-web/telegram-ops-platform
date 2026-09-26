import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
test('mini: actual logger excludes headers, initData, credentials and raw database errors',()=>{
 // Child process captures real stdout/stderr without changing the production logger.
 const code=`
 import {createApp} from './src/app.ts';
 import {randomUUID} from 'node:crypto';
 const db={query:async()=>{throw new Error('RAW_ERROR_CANARY');},transaction:async()=>{throw new Error('RAW_ERROR_CANARY');}};
 const app=createApp(db,()=> 'SECRET_CANARY',async()=>{throw Error('AUTH_CANARY');},undefined,
 {bindings:[{appKey:'logging',botId:randomUUID(),origin:'https://mini.example.test',tokenSecretRef:'TEST_REF'}]});
 const r=await app.inject({method:'POST',url:'/v1/mini/auth/exchange',headers:{origin:'https://mini.example.test',
 authorization:'Bearer AUTH_HEADER_CANARY',cookie:'COOKIE_CANARY','x-csrf-token':'CSRF_CANARY'},
 payload:{appKey:'logging',initData:'INITDATA_CANARY'}});
 if(r.statusCode!==500) process.exitCode=1;
 await app.close();`;
 const r=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',code],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);const logs=r.stdout+r.stderr;
 assert.match(logs,/request_failed/);
 assert.doesNotMatch(logs,/RAW_ERROR_CANARY|SECRET_CANARY|AUTH_CANARY|AUTH_HEADER_CANARY|COOKIE_CANARY|CSRF_CANARY|INITDATA_CANARY/);
});
