import {DomainError,one,type Queryable} from './db.js';
export async function adminProfile(db:Queryable,adminId:string) {
 return one(db,`SELECT id,display_name AS "displayName",status,ui_language AS "uiLanguage" FROM admins WHERE id=$1 AND status='active'`,[adminId]);
}
export async function permissionGrants(db:Queryable,adminId:string) {
 const result=await db.query(`SELECT ar.brand_id AS "brandId",ar.bot_id AS "botId",r.name AS role,
 array_agg(DISTINCT p.name ORDER BY p.name) AS permissions
 FROM admin_roles ar JOIN admins a ON a.id=ar.admin_id JOIN roles r ON r.id=ar.role_id
 JOIN role_permissions rp ON rp.role_id=r.id JOIN permissions p ON p.id=rp.permission_id
 WHERE a.id=$1 AND a.status='active' AND (ar.brand_id IS NOT NULL OR r.name='Super Admin')
 GROUP BY ar.id,r.name ORDER BY ar.brand_id NULLS FIRST,ar.bot_id NULLS FIRST,r.name`,[adminId]);
 return result.rows;
}
export async function accessibleBrands(db:Queryable,adminId:string) {
 return (await db.query(`SELECT b.id AS "brandId",b.name,b.status,b.default_language AS "defaultLanguage"
 FROM brands b WHERE EXISTS (SELECT 1 FROM admin_roles ar JOIN admins a ON a.id=ar.admin_id
 JOIN roles r ON r.id=ar.role_id JOIN role_permissions rp ON rp.role_id=r.id
 WHERE a.id=$1 AND a.status='active' AND ((ar.brand_id IS NULL AND r.name='Super Admin') OR ar.brand_id=b.id)) ORDER BY b.name,b.id`,[adminId])).rows;
}
export async function accessibleBots(db:Queryable,adminId:string,brandId:string) {
 if(!(await accessibleBrands(db,adminId)).some(b=>b.brandId===brandId)) throw new DomainError('forbidden',403);
 return (await db.query(`SELECT b.id AS "botId",b.brand_id AS "brandId",b.name,b.username,b.status,b.default_language AS "defaultLanguage"
 FROM telegram_bots b WHERE b.brand_id=$2 AND EXISTS (SELECT 1 FROM admin_roles ar JOIN admins a ON a.id=ar.admin_id
 JOIN roles r ON r.id=ar.role_id JOIN role_permissions rp ON rp.role_id=r.id
 WHERE a.id=$1 AND a.status='active' AND ((ar.brand_id IS NULL AND r.name='Super Admin') OR
 (ar.brand_id=b.brand_id AND (ar.bot_id IS NULL OR ar.bot_id=b.id)))) ORDER BY b.name,b.id`,[adminId,brandId])).rows;
}
