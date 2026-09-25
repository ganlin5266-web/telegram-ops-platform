import {postgres} from './db.js';
import {seedStaging,seedMode,SeedError} from './staging-seed.js';
let db:ReturnType<typeof postgres>|undefined;
try {
 const apply=seedMode(process.argv.slice(2));
 if(!process.env.DATABASE_URL) throw new SeedError('database_url_required');
 const url=new URL(process.env.DATABASE_URL);
 if(!['postgres:','postgresql:'].includes(url.protocol)) throw new SeedError('invalid_database_url');
 // Local maintenance connections must verify the external endpoint certificate and host.
 url.searchParams.delete('ssl');url.searchParams.delete('uselibpqcompat');url.searchParams.set('sslmode','verify-full');
 if(process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0') throw new SeedError('tls_verification_disabled');
 db=postgres(url.href);
 console.log(JSON.stringify(await seedStaging(db,apply)));
} catch(error) {
 const code=error instanceof SeedError?error.code:'seed_failed';
 const pgCode=(error as {code?:string}).code;
 console.error(JSON.stringify({error:code,...(['23505','42501','25006','40001','40P01','28000','28P01'].includes(pgCode??'')?{postgresqlCode:pgCode}:{})}));
 process.exitCode=1;
} finally {if(db) await db.close();}
