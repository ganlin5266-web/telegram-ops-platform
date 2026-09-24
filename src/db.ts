import pg from 'pg';
export interface Result<T> { rows: T[] }
export interface Queryable { query<T extends Record<string, any> = Record<string, any>>(sql: string, params?: any[]): Promise<Result<T>> }
export interface Database extends Queryable { transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> }
export function postgres(url: string): Database & { close(): Promise<void> } {
 const pool = new pg.Pool({connectionString:url, max:10, connectionTimeoutMillis:5000});
 return {
  query: (sql,params) => pool.query(sql,params),
  async transaction(fn) {
   const client=await pool.connect();
   try { await client.query('BEGIN'); const result=await fn(client); await client.query('COMMIT'); return result; }
   catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }, close:()=>pool.end()
 };
}
export async function one<T extends Record<string, any> = Record<string, any>>(db:Queryable, sql:string, params:any[]=[]):Promise<T> {
 const row=(await db.query<T>(sql,params)).rows[0]; if(!row) throw new DomainError('not_found',404); return row;
}
export class DomainError extends Error { constructor(public code:string, public status=409) { super(code); } }
export type Scope={brandId:string;botId:string};
export const scopeParams=(s:Scope)=>[s.brandId,s.botId];
