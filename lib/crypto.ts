import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function key():Buffer {
  const value=process.env.APP_ENCRYPTION_KEY;
  if(!value)throw new Error('APP_ENCRYPTION_KEY is missing. Generate 32 random bytes encoded as base64 and keep this server secret unchanged.');
  const result=Buffer.from(value,'base64');
  if(result.length!==32||result.toString('base64')!==value)throw new Error('APP_ENCRYPTION_KEY must contain exactly 32 random bytes encoded as base64.');
  return result;
}
export function encryptSecret(value:string):string {
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(),iv);
  const ciphertext=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return ['v1',iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),ciphertext.toString('base64url')].join('.');
}
export function decryptSecret(value:unknown):string {
  if(value===null||value===undefined||value==='')return '';
  if(typeof value!=='string')throw new Error('The saved provider key is invalid. Re-enter it in API settings.');
  const [version,iv,tag,ciphertext,...extra]=value.split('.');
  if(version!=='v1'||!iv||!tag||!ciphertext||extra.length)throw new Error('This provider key uses an unsupported format. Re-enter it in API settings.');
  const decoder=createDecipheriv('aes-256-gcm',key(),Buffer.from(iv,'base64url'));
  decoder.setAuthTag(Buffer.from(tag,'base64url'));
  try{return Buffer.concat([decoder.update(Buffer.from(ciphertext,'base64url')),decoder.final()]).toString('utf8');}
  catch{throw new Error('The saved provider key cannot be decrypted. Restore APP_ENCRYPTION_KEY or re-enter the key in API settings.');}
}
