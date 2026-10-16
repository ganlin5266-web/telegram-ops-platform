import {createCipheriv,createDecipheriv,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';

export type EncryptedCode={ciphertext:Buffer;iv:Buffer;authTag:Buffer;keyVersion:string;fingerprint:string};
export type RedemptionCodeVault={encrypt(code:string,platformId:string):EncryptedCode;decrypt(row:any,platformId:string):string;fingerprint(code:string,platformId:string):string};

const codePattern=/^[\x21-\x7e]{4,160}$/;
function key(value:string|undefined,label:string) {
 if(!value) throw new Error(`${label} required`);
 const decoded=Buffer.from(value,'base64');
 if(decoded.length!==32) throw new Error(`${label} must be 32-byte base64`);
 return decoded;
}
export function createRedemptionCodeVault(env:NodeJS.ProcessEnv):RedemptionCodeVault|undefined {
 const any=Boolean(env.REDEMPTION_CODE_ENCRYPTION_KEY||env.REDEMPTION_CODE_FINGERPRINT_KEY);
 if(!any) return undefined;
 const encryption=key(env.REDEMPTION_CODE_ENCRYPTION_KEY,'REDEMPTION_CODE_ENCRYPTION_KEY');
 const fingerprintKey=key(env.REDEMPTION_CODE_FINGERPRINT_KEY,'REDEMPTION_CODE_FINGERPRINT_KEY');
 const version=env.REDEMPTION_CODE_KEY_VERSION;
 if(!version||!/^[a-zA-Z0-9._-]{1,32}$/.test(version)) throw new Error('Invalid REDEMPTION_CODE_KEY_VERSION');
 const fingerprint=(code:string,platformId:string)=>createHmac('sha256',fingerprintKey).update(`${platformId}\0${code}`).digest('hex');
 return {
  fingerprint,
  encrypt(code,platformId) {
   if(!codePattern.test(code)) throw new Error('invalid_redemption_code');
   const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',encryption,iv);
   cipher.setAAD(Buffer.from(`${platformId}\0${version}`));
   const ciphertext=Buffer.concat([cipher.update(code,'utf8'),cipher.final()]);
   return {ciphertext,iv,authTag:cipher.getAuthTag(),keyVersion:version,fingerprint:fingerprint(code,platformId)};
  },
  decrypt(row,platformId) {
   if(row.code_key_version!==version) throw new Error('redemption_code_key_unavailable');
   const decipher=createDecipheriv('aes-256-gcm',encryption,Buffer.from(row.code_iv));
   decipher.setAAD(Buffer.from(`${platformId}\0${version}`));decipher.setAuthTag(Buffer.from(row.code_auth_tag));
   const code=Buffer.concat([decipher.update(Buffer.from(row.code_ciphertext)),decipher.final()]).toString('utf8');
   const expected=Buffer.from(fingerprint(code,platformId),'hex'),actual=Buffer.from(String(row.code_fingerprint),'hex');
   if(expected.length!==actual.length||!timingSafeEqual(expected,actual)) throw new Error('redemption_code_integrity_failed');
   return code;
  }
 };
}
