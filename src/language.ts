import {DomainError,one,scopeParams,type Queryable,type Scope} from './db.js';
// Admin locale is intentionally not an input to Telegram language resolution.
export function resolveLanguage(user:{preferred_language?:string|null;telegram_language_code?:string|null},bot:{default_language:string;supported_languages:string[]},brand:{default_language:string}) {
 for(const candidate of [user.preferred_language,user.telegram_language_code,bot.default_language,brand.default_language]) {
  if(!candidate) continue;
  const exact=bot.supported_languages.find(l=>l.toLowerCase()===candidate.toLowerCase()); if(exact) return exact;
  // Only use regional matching if exactly one supported language matches.
  const matches=bot.supported_languages.filter(l=>l.split('-')[0]?.toLowerCase()===candidate.toLowerCase());
  if(matches.length===1) return matches[0]!;
 }
 throw new DomainError('no_supported_language');
}
export async function getTemplate(tx:Queryable,s:Scope,userId:string,key:string) {
 const bot=await one(tx,'SELECT * FROM telegram_bots WHERE brand_id=$1 AND id=$2',scopeParams(s));
 const brand=await one(tx,'SELECT default_language FROM brands WHERE id=$1',[s.brandId]);
 const user=await one(tx,'SELECT * FROM telegram_users WHERE brand_id=$1 AND bot_id=$2 AND id=$3',[...scopeParams(s),userId]);
 const language=resolveLanguage(user as any,bot as any,brand as any);
 for(const fallback of [...new Set([language,bot.default_language,brand.default_language])]) {
  if(!bot.supported_languages.includes(fallback)) continue;
  const row=(await tx.query('SELECT template_key,language,body,version FROM message_templates WHERE brand_id=$1 AND bot_id=$2 AND template_key=$3 AND language=$4 AND enabled',[...scopeParams(s),key,fallback])).rows[0];
  if(row) return row;
 }
 throw new DomainError('template_missing');
}
