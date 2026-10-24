import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {encryptSecret,decryptSecret} from '../lib/crypto.ts';

test('provider keys round trip with random IVs and never appear as plaintext',()=>{
  process.env.APP_ENCRYPTION_KEY=randomBytes(32).toString('base64');
  const key='fixture-provider-key',a=encryptSecret(key),b=encryptSecret(key);
  assert.notEqual(a,b);assert.ok(!a.includes(key));assert.equal(decryptSecret(a),key);
  assert.equal(decryptSecret(null),'');assert.equal(decryptSecret(''),'');
});

test('tampering, a changed encryption key and unsupported legacy ciphertext are rejected',()=>{
  process.env.APP_ENCRYPTION_KEY=randomBytes(32).toString('base64');
  const encrypted=encryptSecret('secret-key');
  const parts=encrypted.split('.');parts[3]=Buffer.from('tampered').toString('base64url');
  assert.throws(()=>decryptSecret(parts.join('.')),/cannot be decrypted/);
  process.env.APP_ENCRYPTION_KEY=randomBytes(32).toString('base64');
  assert.throws(()=>decryptSecret(encrypted),/cannot be decrypted/);
  assert.throws(()=>decryptSecret('old.iv.ciphertext'),/unsupported format/);
});

test('an absent or malformed deployment encryption secret fails closed',()=>{
  delete process.env.APP_ENCRYPTION_KEY;assert.throws(()=>encryptSecret('key'),/missing/);
  for(const invalid of ['not-base64',Buffer.alloc(16).toString('base64')]){
    process.env.APP_ENCRYPTION_KEY=invalid;assert.throws(()=>encryptSecret('key'),/32 random bytes/);
  }
});
