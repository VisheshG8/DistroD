import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateWorkspace, calculateHealthScores, alertCandidates, median, quantile, consistency, rangeForPreset, previousRange, normalizeRange, proratedPay} from '../lib/analytics/metrics.ts';

const DAY=86_400_000;
const at=day=>new Date(day+'T00:00:00+05:30').toISOString();
const later=(stamp,days)=>new Date(Date.parse(stamp)+days*DAY).toISOString();
const now=at('2026-10-26');
const range={from:'2026-10-01',to:'2026-10-25'};
const post=(id,publishedAt,values={})=>({id,pageId:'page',platform:'instagram',url:'https://instagram.com/p/'+id,title:id,publishedAt,thumbnail:null,durationSeconds:null,views:100,likes:5,comments:1,shares:null,saves:null,...values});
const page=(id='page',posts=[],values={})=>({id,platform:'instagram',handle:id,url:'https://instagram.com/'+id,name:id,followers:null,lastSyncedAt:now,syncError:null,posts:posts.map(p=>({...p,pageId:id})),monthlyPay:3100,editor:'Editor',startDate:'2026-01-01',active:true,notes:'',coverage:{requestedMode:'posts',complete:true},...values});
const snap=(postId,observedAt,views,pageId='page',values={})=>({pageId,postId,observedAt,views,likes:5,comments:1,shares:null,saves:null,...values});
const account=(observedAt,followers,pageId='page')=>({pageId,observedAt,followers,following:null,postCount:null});
const data=(pages,postSnapshots=[],accountSnapshots=[],values={})=>({pages,postSnapshots,accountSnapshots,alerts:[],generatedAt:now,...values});
const analyze=(dataset,selected=range,compare=null,clock=now)=>calculateWorkspace(dataset,selected,compare,clock);
const metric=(dataset,selected=range,clock=now)=>analyze(dataset,selected,null,clock).pages[0].metrics;

test('India presets, inclusive custom dates, previous periods and leap dates are valid',()=>{
  assert.deepEqual(rangeForPreset('today','2026-10-25T20:00:00Z'),{from:'2026-10-26',to:'2026-10-26'});
  assert.deepEqual(rangeForPreset('7d',now),{from:'2026-10-20',to:'2026-10-26'});
  assert.deepEqual(rangeForPreset('last-month','2024-03-01T00:00:00Z'),{from:'2024-02-01',to:'2024-02-29'});
  assert.deepEqual(previousRange({from:'2026-10-01',to:'2026-10-15'}),{from:'2026-09-16',to:'2026-09-30'});
  assert.throws(()=>normalizeRange({from:'2026-02-29',to:'2026-03-01'}),/valid calendar/);
  assert.throws(()=>normalizeRange({from:'2026-03-02',to:'2026-03-01'}),/end date/);
});

test('typical performance uses medians and interpolated IQR with no zero-denominator invention',()=>{
  assert.equal(median([1,2,3,100]),2.5);assert.equal(quantile([1,2,3,100],0.75),27.25);
  assert.equal(consistency([1,2,3,100]),10.2);assert.equal(consistency([0,0,0]),null);
  assert.equal(median([]),null);assert.equal(median([1,NaN,3]),2);
});

test('an existing post with only one snapshot has unavailable growth, not an invented zero',()=>{
  const p=post('old',at('2026-09-01'),{views:9000});
  const m=metric(data([page('page',[p])],[snap('old',at('2026-10-25'),9000)]));
  assert.equal(m.viewsGained,null);assert.equal(m.viewsCoverage.status,'unavailable');
  assert.equal(m.medianViews,null);assert.equal(m.followers,null);
});

test('growth uses actual inside-range pairs and records uncovered boundaries',()=>{
  const p=post('old',at('2026-09-01'));
  const m=metric(data([page('page',[p])],[snap('old',at('2026-09-30'),50),snap('old',at('2026-10-02'),100),snap('old',at('2026-10-24'),180),snap('old',at('2026-10-27'),1000)]));
  assert.equal(m.viewsGained,80);assert.equal(m.viewsCoverage.status,'partial');
  assert.equal(m.viewsCoverage.from,at('2026-10-02'));assert.equal(m.viewsCoverage.to,at('2026-10-24'));
});

test('exact boundary pairs are complete and negative corrections remain visible',()=>{
  const p=post('old',at('2026-09-01'));
  const m=metric(data([page('page',[p])],[snap('old',at('2026-10-01'),200),snap('old',now,150)]));
  assert.equal(m.viewsGained,-50);assert.equal(m.viewsCoverage.status,'complete');
  assert.equal(m.viewsCoverage.adjustments,1);assert.equal(m.costPerMillion,null);
});

test('a post born inside the range can have a real zero baseline; the exclusive end is not a publication day',()=>{
  const born=post('new',at('2026-10-05')),excluded=post('next',now);
  const m=metric(data([page('page',[born,excluded])],[snap('new',now,450),snap('next',now,999)]));
  assert.equal(m.viewsGained,450);assert.equal(m.postsPublished,1);assert.equal(m.viewsCoverage.status,'complete');
});

test('missing metrics stay unavailable and malformed counters cannot enter the history total',()=>{
  const p=post('old',at('2026-09-01'),{views:null,likes:null,comments:null});
  const m=metric(data([page('page',[p])],[snap('old',at('2026-10-01'),null),snap('old',now,-2)]));
  assert.equal(m.viewsGained,null);assert.equal(m.engagementRate,null);assert.equal(m.shares,null);
});

test('follower growth starts with recorded history and permits a known zero without dividing by zero',()=>{
  const m=metric(data([page()],[],[account(at('2026-10-01'),0),account(now,5)]));
  assert.equal(m.followers,5);assert.equal(m.followerGrowth,5);assert.equal(m.followerGrowthRate,null);
  assert.equal(m.followerCoverage.status,'complete');
  const one=metric(data([page()],[],[account(now,1000)]));assert.equal(one.followerGrowth,null);
});

test('only real observations at age seven to eight days qualify for typical performance',()=>{
  const p=post('a',at('2026-10-01'),{views:99999});
  let d=data([page('page',[p])],[snap('a',at('2026-10-07'),50),snap('a',at('2026-10-10'),500)]);
  assert.equal(metric(d).medianViews,null);
  d.postSnapshots.push(snap('a',at('2026-10-08'),100));
  assert.equal(metric(d).medianViews,100);assert.equal(metric(d).averageViews,100);
});

test('cumulative old post counters cannot borrow a later page-refresh timestamp',()=>{
  const p=post('a',at('2026-10-01'),{views:9000});
  const d=data([page('page',[p],{lastSyncedAt:at('2026-10-08')})]);
  assert.equal(metric(d).medianViews,null);
  d.pages[0].posts[0].observedAt=at('2026-10-08');assert.equal(metric(d).medianViews,9000);
});

test('immature posts and their large current counts do not enter medians or health activity',()=>{
  const p=post('mature',at('2026-10-01')),young=post('young',at('2026-10-24'),{views:1000000});
  const report=analyze(data([page('page',[p,young])],[snap('mature',at('2026-10-08'),100),snap('young',at('2026-10-25'),1000000)]));
  const a=report.pages[0];assert.equal(a.metrics.medianViews,100);assert.equal(a.metrics.postsPublished,2);
  assert.equal(a.metrics.maturedPostsPerDay,1/25);assert.equal(a.health.score,null);
  assert.equal(a.posts.find(p=>p.id==='young').maturing,true);
});

test('same-platform workspace medians pool comparable posts, not page medians, and engagement is view weighted',()=>{
  const a=page('a',[post('a1',at('2026-10-01'))]);
  const b=page('b',[post('b1',at('2026-10-01')),post('b2',at('2026-10-02')),post('b3',at('2026-10-03'))]);
  const snapshots=[snap('a1',at('2026-10-08'),1,'a'),snap('b1',at('2026-10-08'),3,'b'),snap('b2',at('2026-10-09'),5,'b'),snap('b3',at('2026-10-10'),100,'b')];
  const report=analyze(data([a,b],snapshots));assert.equal(report.totals.medianViews,4);
  assert.equal(report.totals.engagementRate,24/109);
});

function comparablePage(id,platform='instagram'){
  const posts=[],snapshots=[];
  for(let i=0;i<8;i++){
    for(const month of ['09','10']){
      const day=`2026-${month}-${String(i+1).padStart(2,'0')}`,p=post(`${month}-${i}`,at(day),{views:100+i*10});posts.push(p);
      snapshots.push(snap(p.id,later(p.publishedAt,7),100+i*10,id));
    }
  }
  return {p:page(id,posts,{platform}),snapshots,accounts:[account(at('2026-10-01'),1000,id),account(now,1100,id)]};
}

test('health uses the exact six weights, tied peers score fifty, and cross-platform pages never become peers',()=>{
  const a=comparablePage('a'),b=comparablePage('b'),y=comparablePage('yt','youtube');
  const report=analyze(data([a.p,b.p,y.p],[...a.snapshots,...b.snapshots,...y.snapshots],[...a.accounts,...b.accounts,...y.accounts]));
  assert.equal(report.pages[0].health.score,50);assert.equal(report.pages[0].health.peerCount,2);
  assert.deepEqual(report.pages[0].health.components.map(c=>c.weight),[30,20,15,15,10,10]);
  assert.equal(report.pages[2].health.score,null);assert.equal(report.totals.engagementRate,null);assert.equal(report.totals.medianViews,null);
  assert.equal(report.platforms.length,2);assert.ok(report.platforms.every(p=>p.rankings.every(row=>row.page.platform===p.platform)));
});

test('eight matured comparable posts cannot manufacture missing health components',()=>{
  const a=comparablePage('a'),b=comparablePage('b');
  const report=analyze(data([a.p,b.p],[...a.snapshots,...b.snapshots]));
  assert.equal(report.pages[0].health.score,null);assert.match(report.pages[0].health.reason,/follower growth/);
});

test('pay uses leap-month lengths, inclusive dates and page start dates',()=>{
  assert.equal(proratedPay(2900,{from:'2024-02-01',to:'2024-02-29'},null,'2024-04-01'),2900);
  assert.equal(proratedPay(2900,{from:'2024-02-15',to:'2024-02-29'},null,'2024-04-01'),1500);
  assert.equal(proratedPay(2900,{from:'2024-02-29',to:'2024-03-01'},null,'2024-04-01'),193.55);
  assert.equal(proratedPay(3100,range,'2026-10-24',now),200);
  assert.equal(proratedPay(null,range,null,now),null);assert.equal(proratedPay(0,range,null,now),0);
});

test('cost per million and its inverse use observed views with zero-denominator protection',()=>{
  const p=post('a',at('2026-10-01'));
  const m=metric(data([page('page',[p])],[snap('a',now,1000)]));
  assert.equal(m.pay,2500);assert.equal(m.costPerMillion,2500000);assert.equal(m.viewsPerThousand,400);
  const zero=metric(data([page('page',[p],{monthlyPay:0})],[snap('a',now,1000)]));assert.equal(zero.costPerMillion,0);assert.equal(zero.viewsPerThousand,null);
  const noViews=metric(data([page('page',[p])],[snap('a',now,0)]));assert.equal(noViews.costPerMillion,null);
});

test('comparison percentages against zero are unavailable and incomplete periods cannot claim an economic verdict',()=>{
  const p=post('a',at('2026-09-01'));
  const report=analyze(data([page('page',[p])],[snap('a',at('2026-09-01'),0),snap('a',at('2026-10-01'),0),snap('a',at('2026-10-20'),100)]),range,{from:'2026-09-01',to:'2026-09-30'});
  assert.equal(report.comparison.metrics.viewsGained.percent,null);assert.match(report.comparison.verdict,/complete observation boundaries/);
  assert.equal(report.monthly[0].month,'2026-10');
});

test('monthly rows clip to the chosen range and charts preserve measured negative corrections',()=>{
  const p=post('a',at('2026-08-01'));
  const report=analyze(data([page('page',[p])],[snap('a',at('2026-10-01'),300),snap('a',at('2026-10-03'),200)]),{from:'2026-08-20',to:'2026-10-25'});
  assert.deepEqual(report.monthly.map(row=>row.month),['2026-08','2026-09','2026-10']);
  assert.equal(report.monthly[0].range.from,'2026-08-20');assert.equal(report.timeline.find(row=>row.date==='2026-10-03').viewsGained,-100);
});

function alertData(){
  const posts=[],snapshots=[];
  for(let i=0;i<10;i++){
    const published=later(now,-35-i),p=post('base'+i,published);posts.push(p);snapshots.push(snap(p.id,later(published,7),100));
  }
  for(let i=0;i<5;i++){
    const published=later(now,-15-i),p=post('prev'+i,published);posts.push(p);snapshots.push(snap(p.id,later(published,7),100));
  }
  for(let i=0;i<2;i++){
    const published=later(now,-8-i),p=post('recent'+i,published);posts.push(p);snapshots.push(snap(p.id,later(published,7),50));
  }
  posts.push(post('young',later(now,-1),{views:10000000}));
  return data([page('page',posts)],snapshots,[account(later(now,-45),1000)]);
}

test('performance alert candidates use matured fixed-age posts and recent immature posts prevent a false inactivity alert',()=>{
  const d=alertData(),alerts=alertCandidates(d,now),types=alerts.map(alert=>alert.type);
  assert.ok(types.includes('median-drop'));assert.ok(types.includes('posting-drop'));assert.ok(types.includes('below-baseline'));
  assert.equal(types.includes('no-posts'),false);assert.equal(types.includes('viral-post'),false);
  assert.deepEqual(alertCandidates(d,now).map(a=>a.fingerprint),alerts.map(a=>a.fingerprint));
});

test('viral opportunities compare age-seven counts with the same page baseline',()=>{
  const d=alertData();d.postSnapshots.find(s=>s.postId==='recent0').views=600;
  const alerts=alertCandidates(d,now);assert.ok(alerts.some(a=>a.type==='viral-post'&&a.fingerprint.endsWith(':recent0')));
});

test('failed fetches produce data-health candidates while inactive and stale pages do not create performance alerts',()=>{
  const d=alertData();d.pages[0].syncError='private';assert.equal(alertCandidates(d,now)[0].type,'data-health');
  d.pages[0].active=false;assert.deepEqual(alertCandidates(d,now),[]);
  d.pages[0].active=true;d.pages[0].syncError=null;d.pages[0].lastSyncedAt=later(now,-5);assert.deepEqual(alertCandidates(d,now),[]);
});

test('a duplicate page or post cannot double count workspace totals',()=>{
  const p=post('a',at('2026-10-01')),a=page('page',[p,p]);
  const report=analyze(data([a,a],[snap('a',now,100)]));assert.equal(report.totals.pages,1);assert.equal(report.totals.postsPublished,1);assert.equal(report.totals.viewsGained,100);
});

test('historical-only and incomplete refreshes cannot produce present-day performance alerts',()=>{
  const d=alertData();
  d.pages[0].coverage={requestedMode:'date',from:at('2026-08-01'),to:at('2026-09-01'),complete:true};
  assert.deepEqual(alertCandidates(d,now),[]);
  d.pages[0].coverage={requestedMode:'posts',complete:false};assert.deepEqual(alertCandidates(d,now),[]);
  d.pages[0].coverage={requestedMode:'date',from:later(now,-90),to:now,complete:true};assert.ok(alertCandidates(d,now).length>0);
});

test('search or collection filters can reuse full-workspace peers without changing page health',()=>{
  const a=comparablePage('a'),b=comparablePage('b');
  const full=data([a.p,b.p],[...a.snapshots,...b.snapshots],[...a.accounts,...b.accounts]);
  const scores=calculateHealthScores(full,range,now);
  const scoped=calculateWorkspace({...full,pages:[a.p]},range,null,now,scores);
  assert.equal(scoped.pages[0].health.score,50);assert.equal(scoped.pages[0].health.peerCount,2);
  assert.equal(scoped.platforms[0].rankings[0].health.score,50);
});
