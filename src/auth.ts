import {createHash} from 'node:crypto';
import {DomainError,one,scopeParams,type Queryable,type Scope} from './db.js';
export type Principal={adminId:string};
export type Authenticator=(authorization:string|undefined)=>Promise<Principal>;
// Service-side opaque credentials for initial integration; replace with OIDC verifier next phase.
// Only SHA256 digests are stored in env, each bound to an individual admin UUID.
export function credentialAuthenticator(json:string):Authenticator {
 const credentials:Record<string,string>=JSON.parse(json);
 return async authorization=>{
  const token=authorization?.match(/^Bearer (\S+)$/)?.[1];
  if(!token||token.length<32) throw new DomainError('unauthorized',401);
  const adminId=credentials[createHash('sha256').update(token).digest('hex')];
  if(!adminId) throw new DomainError('unauthorized',401);return {adminId};
 };
}
export async function authorize(tx:Queryable,p:Principal,s:Scope,permission:string) {
 await one(tx,'SELECT id FROM telegram_bots WHERE brand_id=$1 AND id=$2',scopeParams(s));
 const allowed=(await tx.query(`SELECT a.id FROM admins a JOIN admin_roles ar ON ar.admin_id=a.id
 JOIN roles r ON r.id=ar.role_id JOIN role_permissions rp ON rp.role_id=r.id JOIN permissions pm ON pm.id=rp.permission_id
 WHERE a.id=$1 AND a.status='active' AND pm.name=$2
 AND ((ar.brand_id=$3 AND (ar.bot_id IS NULL OR ar.bot_id=$4)) OR (ar.brand_id IS NULL AND r.name='Super Admin')) LIMIT 1`,[p.adminId,permission,...scopeParams(s)])).rows[0];
 if(!allowed) throw new DomainError('forbidden',403);
}
