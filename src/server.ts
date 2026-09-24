import {createApp} from './app.js';
import {postgres} from './db.js';
import {credentialAuthenticator} from './auth.js';
if(!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
const db=postgres(process.env.DATABASE_URL);
const app=createApp(db,ref=>process.env[ref],credentialAuthenticator(process.env.ADMIN_CREDENTIALS_JSON??'{}'));
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,async()=>{await app.close();await db.close();process.exit(0);});
await app.listen({port:Number(process.env.PORT??3000),host:process.env.HOST??'127.0.0.1'});
