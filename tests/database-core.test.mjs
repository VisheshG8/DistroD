import test from 'node:test';
import assert from 'node:assert/strict';
import {postgresPlaceholders,normalizeDatabaseValue} from '../lib/database-core.ts';

test('query placeholders preserve quoted values, identifiers, comments and dollar-quoted bodies',()=>{
  const query=`select ?, '?' AS "?", $$?$$, $body$?$body$, ? -- ?
    /* ? /* nested ? */ ? */ where value=? and text='it''s ?'`;
  const converted=postgresPlaceholders(query);
  assert.ok(converted.startsWith(`select $1, '?' AS "?", $$?$$, $body$?$body$, $2 -- ?`));
  assert.ok(converted.endsWith(`where value=$3 and text='it''s ?'`));
  assert.ok(converted.includes('/* ? /* nested ? */ ? */'));
});

test('database normalization preserves JSON counters and converts timestamps without losing precision',()=>{
  assert.deepEqual(normalizeDatabaseValue({time:new Date('2026-10-24T00:00:00Z'),count:42n,posts:[{views:0,likes:null}]}),{
    time:'2026-10-24T00:00:00.000Z',count:42,posts:[{views:0,likes:null}],
  });
  assert.throws(()=>normalizeDatabaseValue(9007199254740992n),/safe integer/);
});
