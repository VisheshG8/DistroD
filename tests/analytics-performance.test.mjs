import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateWorkspace,calculateHealthScores,createWorkspaceCalculator} from '../lib/analytics/metrics.ts';
import {analyticsPerformanceFixture,performanceRange as range,performanceComparison as comparison} from './helpers/analytics-performance-fixture.mjs';

test('filtering reuses one history index and retains exact reports, selected-page alerts, and full-workspace health',()=>{
  const dataset=analyticsPerformanceFixture(6,60);
  const scores=calculateHealthScores(dataset,range);
  let historyScans=0;
  const iterate=dataset.postSnapshots[Symbol.iterator].bind(dataset.postSnapshots);
  dataset.postSnapshots[Symbol.iterator]=function(){historyScans++;return iterate();};
  const calculate=createWorkspaceCalculator(dataset);
  assert.equal(historyScans,1);
  const selected=new Set(['page-0','page-3','missing-page']);
  const result=calculate(range,comparison,undefined,scores,selected);
  const second=calculate(range,comparison,undefined,scores,new Set(['page-3']));
  assert.equal(historyScans,1,'changing a filter must not scan the entire snapshot array again');
  delete dataset.postSnapshots[Symbol.iterator];
  assert.deepEqual(result,calculateWorkspace({...dataset,pages:dataset.pages.filter(page=>selected.has(page.id))},range,comparison,undefined,scores));
  assert.deepEqual(second,calculateWorkspace({...dataset,pages:[dataset.pages[3]]},range,comparison,undefined,scores));
  assert.deepEqual(result.alerts.map(alert=>alert.pageId),['page-0','page-3']);
  assert.deepEqual(result.pages.map(page=>page.health),[scores['page-0'],scores['page-3']]);
  assert.ok(result.monthly.length>1);assert.ok(result.comparison);
});

test('prepared history changes with the observation clock and is isolated between loaded datasets',()=>{
  const dataset=analyticsPerformanceFixture(2,40),calculate=createWorkspaceCalculator(dataset);
  const first=calculate(range,comparison);
  const earlier='2026-09-15T00:00:00Z';
  assert.deepEqual(calculate(range,comparison,earlier),calculateWorkspace(dataset,range,comparison,earlier));
  assert.deepEqual(calculate(range,comparison),first);
  const replacement=structuredClone(dataset);
  replacement.pages[0].followers=99999;
  replacement.accountSnapshots.push({pageId:'page-0',observedAt:'2026-10-25T12:00:00Z',followers:99999,following:null,postCount:null});
  const changed=createWorkspaceCalculator(replacement)(range,comparison);
  assert.notEqual(changed.totals.followers,first.totals.followers);
  assert.deepEqual(calculate(range,comparison),first,'a second workspace cannot replace cached observations');
  const empty=calculate(range,comparison,undefined,undefined,new Set());
  assert.equal(empty.totals.pages,0);assert.deepEqual(empty.alerts,[]);
});

test('multi-year chart aggregation keeps each selected page aligned on monthly dates',()=>{
  const dataset=analyticsPerformanceFixture(),longRange={from:'2024-01-01',to:'2026-10-25'};
  const result=calculateWorkspace(dataset,longRange);
  for(const [index,point] of result.timeline.entries()){
    assert.ok(result.pages.every(page=>page.timeline[index].date===point.date));
    const known=result.pages.map(page=>page.timeline[index].viewsGained).filter(value=>value!==null);
    assert.equal(point.viewsGained,known.length?known.reduce((a,b)=>a+b,0):null);
    assert.equal(point.postsPublished,result.pages.reduce((total,page)=>total+page.timeline[index].postsPublished,0));
  }
});
