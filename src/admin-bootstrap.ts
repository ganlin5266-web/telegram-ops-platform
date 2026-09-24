import {z} from 'zod';
import {hashPassword} from './passwords.js';
import {DomainError,one,type Database} from './db.js';
import {securityAudit} from './browser-auth.js';
export const bootstrapInput=z.object({login:z.string().trim().toLowerCase().min(3).max(120).regex(/^[a-z0-9@._+-]+$/),displayName:z.string().trim().min(1).max(120),password:z.string()}).strict();
export async function bootstrapFirstAdmin(db:Database,input:unknown) {
 const data=bootstrapInput.parse(input);const hash=await hashPassword(data.password);
 return db.transaction(async tx=>{
  await tx.query('LOCK TABLE admins IN EXCLUSIVE MODE');
  if((await tx.query('SELECT id FROM admins LIMIT 1')).rows.length) throw new DomainError('bootstrap_already_completed');
  const admin=await one(tx,"INSERT INTO admins(auth_subject,display_name,ui_language) VALUES($1,$2,'zh-CN') RETURNING id",[`local:${data.login}`,data.displayName]);
  await tx.query('INSERT INTO admin_credentials(admin_id,login,password_hash) VALUES($1,$2,$3)',[admin.id,data.login,hash]);
  await tx.query("INSERT INTO admin_roles(admin_id,role_id) SELECT $1,id FROM roles WHERE name='Super Admin'",[admin.id]);
  await securityAudit(tx,'auth.bootstrap',admin.id,undefined,admin.id);return {adminId:admin.id};
 });
}
