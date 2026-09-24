import {postgres} from './db.js';
import {migrate} from './migrations.js';
if(!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
const db=postgres(process.env.DATABASE_URL);
try {await migrate(db); console.log('Migrations applied');} finally {await db.close();}
