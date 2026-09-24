import {randomBytes,scrypt,timingSafeEqual} from 'node:crypto';
import {DomainError} from './db.js';
const N=32768,r=8,p=3;
function derive(password:string,salt:string):Promise<Buffer> {
 return new Promise((resolve,reject)=>scrypt(password,salt,64,{N,r,p,maxmem:64*1024*1024},(error,key)=>error?reject(error):resolve(key)));
}
export async function hashPassword(password:string) {
 if(password.length<15||Buffer.byteLength(password)>128) throw new DomainError('password_policy',400);
 const salt=randomBytes(16).toString('hex');
 return `scrypt$${N}$${r}$${p}$${salt}$${(await derive(password,salt)).toString('hex')}`;
}
export async function verifyPassword(password:string,encoded:string) {
 const parts=encoded.split('$');
 if(parts.length!==6||parts[0]!=='scrypt'||parts[1]!==String(N)||parts[2]!==String(r)||parts[3]!==String(p)||!/^[a-f0-9]{32}$/.test(parts[4]!)||!/^[a-f0-9]{128}$/.test(parts[5]!)) return false;
 const actual=await derive(password,parts[4]!);return timingSafeEqual(actual,Buffer.from(parts[5]!,'hex'));
}
// A valid cost-equivalent dummy record makes unknown-login verification do the
// same expensive work. It is not an account or a usable authentication credential.
export const dummyPasswordHash=`scrypt$${N}$${r}$${p}$${'0'.repeat(32)}$${'0'.repeat(128)}`;
