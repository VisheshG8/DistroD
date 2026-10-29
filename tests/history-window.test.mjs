import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {Script} from 'node:vm';
import {scopeFromDates} from '../lib/scope.ts';

const source=readFileSync(new URL('../lib/analytics/history-window.ts',import.meta.url),'utf8').replace(/^import[^;]*;\r?\n/gm,'');
const code=stripTypeScriptTypes(source,{mode:'transform'}).replace(/\bexport\s+/g,'');
const {historyStart,narrowHistory,HISTORY_REUSE_MS}=new Script(code+'\n;({historyStart,narrowHistory,HISTORY_REUSE_MS})').runInNewContext({scopeFromDates,Date,Infinity,Math});
const day=86400000;

test('history starts 100 days before the earliest selected India day, matching the server window',()=>{
  const start=historyStart({from:'2026-10-01',to:'2026-10-29'},null);
  assert.equal(new Date(start).toISOString(),new Date(Date.parse('2026-09-30T18:30:00.000Z')-100*day).toISOString());
  assert.equal(historyStart({from:'2026-10-01',to:'2026-10-29'},{from:'2026-09-01',to:'2026-09-29'}),Date.parse('2026-08-31T18:30:00.000Z')-100*day);
  assert.ok(HISTORY_REUSE_MS>0);
});

test('a narrower range drops only the observations the server would not have sent',()=>{
  const wide=historyStart({from:'2026-07-01',to:'2026-10-29'},null),narrow=historyStart({from:'2026-10-22',to:'2026-10-29'},null);
  const at=t=>new Date(t).toISOString();
  const dataset={pages:[{id:'p',posts:[{id:'old'}]}],alerts:[{id:'a'}],generatedAt:at(narrow),
    accountSnapshots:[{pageId:'p',observedAt:at(narrow-day)},{pageId:'p',observedAt:at(narrow)},{pageId:'p',observedAt:at(narrow+day)}],
    postSnapshots:[{pageId:'p',postId:'old',observedAt:at(narrow-1)},{pageId:'p',postId:'old',observedAt:at(narrow+5)}]};
  const result=narrowHistory(dataset,wide,narrow);
  assert.deepEqual(result.accountSnapshots.map(s=>s.observedAt),[at(narrow),at(narrow+day)]);
  assert.deepEqual(result.postSnapshots.map(s=>s.observedAt),[at(narrow+5)]);
  assert.equal(result.pages,dataset.pages);assert.equal(result.alerts,dataset.alerts);
  assert.equal(dataset.accountSnapshots.length,3,'the loaded history is not mutated');
  assert.equal(narrowHistory(dataset,narrow,narrow),dataset,'an equal window is reused as is');
});
