import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateWorkspace, calculateHealthScores, alertCandidates, alertCheck, median, quantile, consistency, predictability, rangeForPreset, previousRange, normalizeRange, proratedPay, healthBand, contentStandouts, contentTypeLabel, monthlyChanges, sameDaysPreviousMonth, ALERT_RULES} from '../lib/analytics/metrics.ts';

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

test('health uses the exact six weights, tied peers score alike, a lone page still scores, and cross-platform pages never become peers',()=>{
  const a=comparablePage('a'),b=comparablePage('b'),y=comparablePage('yt','youtube');
  const report=analyze(data([a.p,b.p,y.p],[...a.snapshots,...b.snapshots,...y.snapshots],[...a.accounts,...b.accounts,...y.accounts]));
  const [first,second,lone]=report.pages.map(p=>p.health);
  assert.equal(first.score,second.score);assert.ok(first.score>0&&first.score<100);assert.equal(first.peerCount,2);assert.equal(first.basis,'range');
  assert.deepEqual(first.components.map(c=>c.weight),[30,20,15,15,10,10]);assert.ok(first.components.every(c=>c.percentile===50&&c.score!==null));
  assert.equal(lone.peerCount,1);assert.equal(typeof lone.score,'number');assert.match(lone.reason,/no active peers/);assert.equal(lone.band,healthBand(lone.score));
  assert.equal(report.totals.engagementRate,null);assert.equal(report.totals.medianViews,null);
  assert.equal(report.platforms.length,2);assert.ok(report.platforms.every(p=>p.rankings.every(row=>row.page.platform===p.platform)));
});

test('a missing health component is never invented: the rest is rescaled and the score marked provisional',()=>{
  const a=comparablePage('a'),b=comparablePage('b');
  const report=analyze(data([a.p,b.p],[...a.snapshots,...b.snapshots]));
  const health=report.pages[0].health;assert.equal(health.provisional,true);assert.equal(health.code,'provisional');assert.match(health.reason,/follower growth/);
  assert.equal(health.components.find(c=>c.key==='growth').score,null);
  const young=analyze(data([page('page',[post('a1',at('2026-10-01'))])],[snap('a1',at('2026-10-08'),100)]));
  assert.equal(young.pages[0].health.score,null);assert.equal(young.pages[0].health.code,'few-posts');
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
  assert.equal(scoped.pages[0].health.score,scores.a.score);assert.equal(scoped.pages[0].health.peerCount,2);
  assert.equal(scoped.platforms[0].rankings[0].health.score,scores.a.score);
});

test('daily cron snapshots near the range boundaries count as complete coverage',()=>{
  const p=post('old',at('2026-09-01')),snapshots=[];
  for(let d=1;d<=25;d++)snapshots.push(snap('old',new Date(Date.parse(at(`2026-10-${String(d).padStart(2,'0')}`))+347*60_000).toISOString(),1000+d*10));
  const m=metric(data([page('page',[p])],snapshots));
  assert.equal(m.viewsCoverage.status,'complete');assert.equal(m.viewsGained,240);
});

test('monthly views gained add up to the range total across month boundaries',()=>{
  const old=post('old',at('2026-07-01')),born=post('born',new Date(Date.parse(at('2026-09-30'))+23*3_600_000).toISOString()),snapshots=[];
  for(let t=Date.parse(at('2026-08-01'))+12*3_600_000,i=0;t<=Date.parse(at('2026-10-25'))+12*3_600_000;t+=DAY,i++)snapshots.push(snap('old',new Date(t).toISOString(),i*1000));
  snapshots.push(snap('born',new Date(Date.parse(at('2026-10-01'))+12*3_600_000).toISOString(),500),snap('born',at('2026-10-20'),900));
  const report=analyze(data([page('page',[old,born])],snapshots,[account(at('2026-08-01'),100),account(at('2026-09-15'),150),account(at('2026-10-20'),180)]),{from:'2026-08-01',to:'2026-10-25'});
  assert.equal(report.totals.viewsGained,85_000+900);
  assert.equal(report.monthly.reduce((n,row)=>n+row.totals.viewsGained,0),report.totals.viewsGained);
  assert.deepEqual(report.monthly.map(row=>row.totals.viewsGained),[30_000,30_000,25_900]);
  assert.equal(report.monthly.reduce((n,row)=>n+(row.totals.followerGrowth??0),0),report.totals.followerGrowth);
});

test('workspace cost ratios use the pages that have pay and count them',()=>{
  const paid=page('paid',[post('a',at('2026-10-01'))]),unpaid=page('unpaid',[post('b',at('2026-10-01'))],{monthlyPay:null});
  const t=analyze(data([paid,unpaid],[snap('a',now,1000,'paid'),snap('b',now,9000,'unpaid')])).totals;
  assert.equal(t.pages,2);assert.equal(t.payKnownPages,1);assert.equal(t.costPages,1);assert.equal(t.costViewPages,1);
  assert.equal(t.costPerMillion,2_500_000);assert.equal(t.costPerThousand,2500);assert.equal(t.viewsPerThousand,400);assert.equal(t.costPerPost,2500);
  assert.equal(t.viewsPerPost,5000);
});

test('inactive pages are paid only through their end date and never set the health bar',()=>{
  assert.equal(proratedPay(3100,range,null,now,'2026-10-10'),1000);
  const active=page('on',[post('a',at('2026-10-01'))]),paused=page('off',[post('b',at('2026-10-01'))],{active:false,monthlyPay:9000});
  let t=analyze(data([active,paused],[snap('a',now,1000,'on'),snap('b',now,1000,'off')])).totals;
  assert.equal(t.monthlyPay,3100);assert.equal(t.pay,2500);assert.equal(t.inactivePages,1);assert.equal(t.costPages,1);assert.equal(t.costPerMillion,2_500_000);
  t=analyze(data([active,{...paused,endDate:'2026-10-10'}],[snap('a',now,1000,'on'),snap('b',now,1000,'off')])).totals;
  assert.equal(t.pay,2500+2903.23);assert.equal(t.costPages,2);
  const a=comparablePage('a'),b=comparablePage('b');b.p.active=false;
  const report=analyze(data([a.p,b.p],[...a.snapshots,...b.snapshots],[...a.accounts,...b.accounts]));
  assert.equal(report.pages[0].health.peerCount,1);assert.equal(report.pages[1].health.peerCount,1);assert.equal(typeof report.pages[1].health.score,'number');
});

test('health is an absolute 0-100 scale: stronger pages score higher without binary peer splits, with 80/50 bands',()=>{
  assert.equal(healthBand(92),'good');assert.equal(healthBand(80),'good');assert.equal(healthBand(74),'watch');assert.equal(healthBand(50),'watch');assert.equal(healthBand(43),'low');assert.equal(healthBand(null),'pending');
  const strong=comparablePage('strong'),weak=comparablePage('weak');
  for(const s of weak.snapshots)if(s.postId.startsWith('10-'))s.views=Math.round(s.views*0.8);
  for(const p of weak.p.posts)if(p.id.startsWith('10-'))p.views=Math.round(p.views*0.8);
  const report=analyze(data([strong.p,weak.p],[...strong.snapshots,...weak.snapshots],[...strong.accounts,...weak.accounts]));
  const [s,w]=report.pages.map(p=>p.health.score);
  assert.ok(s>w,'the stronger page scores higher');assert.ok(s-w<40,'two peers are not split into extremes');
  const alone=analyze(data([strong.p],strong.snapshots,strong.accounts)).pages[0].health;assert.ok(Math.abs(alone.score-s)<20);
});

test('Today and 7-day ranges score health on the latest matured window instead of showing nothing',()=>{
  const a=comparablePage('a');
  const week=analyze(data([a.p],a.snapshots,a.accounts),rangeForPreset('7d',now)).pages[0].health;
  assert.equal(typeof week.score,'number');assert.equal(week.basis,'matured-window');assert.equal(week.window.to,'2026-10-19');assert.equal(week.window.from,'2026-09-20');
  assert.match(week.reason,/2026-09-20 to 2026-10-19/);
  const today=calculateHealthScores(data([a.p],a.snapshots,a.accounts),rangeForPreset('today',now),now).a;assert.equal(today.basis,'matured-window');
});

test('consistency rewards predictable pages, not one viral post',()=>{
  assert.equal(predictability([100,110,95,105,102]),97.1);assert.equal(predictability([10,20,15,800,12]),68);
  assert.equal(predictability([5]),null);
});

test('saves, share rate, engagement per post and best and worst posts are measured per page',()=>{
  const posts=[post('a',at('2026-10-01'),{views:1000,shares:10,saves:4,likes:50,comments:5}),post('b',at('2026-10-02'),{views:3000,shares:60,saves:null,likes:90,comments:9}),post('c',at('2026-10-24'),{views:9000,shares:1,saves:2})];
  const report=analyze(data([page('page',posts,{platform:'tiktok'})],[snap('a',at('2026-10-08'),800,'page',{shares:8,saves:3}),snap('b',at('2026-10-09'),2000,'page',{shares:40,saves:null})]));
  const row=report.pages[0],m=row.metrics;
  assert.equal(m.saves,6);assert.equal(m.shareRate,71/13000);assert.equal(m.engagementPerPost,(69+159+9)/3);
  assert.equal(row.bestPost.post.id,'b');assert.equal(row.bestPost.basis,'day-7');assert.equal(row.worstPost.post.id,'a');
  const p=row.posts.find(x=>x.id==='a');assert.equal(p.fixedAgeShares,8);assert.equal(p.fixedAgeSaves,3);assert.equal(p.shareRate,0.01);assert.equal(p.typeLabel,'Video');assert.equal(p.pageEditor,'Editor');
  const fresh=analyze(data([page('page',[post('n',at('2026-10-24'),{views:50}),post('m',at('2026-10-25'),{views:70})])]),rangeForPreset('7d',now));
  assert.equal(fresh.pages[0].bestPost.basis,'latest');assert.equal(fresh.pages[0].bestPost.post.id,'m');assert.equal(fresh.pages[0].worstPost,null,'maturing posts are never the weakest');
  assert.equal(fresh.platforms[0].bestPost.id,'m');assert.equal(fresh.platforms[0].bestPostBasis,'latest');
});

test('review fixes: worst post differs from best, unstarted pay is left out of cost ratios, growth and activity are measured fairly',()=>{
  const single=analyze(data([page('page',[post('a',at('2026-10-02')),post('b',at('2026-10-05'))])],[snap('a',later(at('2026-10-02'),7.5),500)])).pages[0];
  assert.equal(single.bestPost.post.id,'a');assert.equal(single.worstPost,null,'the only measured post is not also the weakest');
  const paid=page('paid',[post('x',at('2026-09-01'))]),later1=page('later',[post('y',at('2026-09-01'))],{startDate:'2026-11-01'}),free=page('free',[post('z',at('2026-09-01'))],{monthlyPay:0});
  const views=[snap('x',at('2026-10-01'),0,'paid'),snap('x',now,1000,'paid'),snap('y',at('2026-10-01'),0,'later'),snap('y',now,1000,'later'),snap('z',at('2026-10-01'),0,'free'),snap('z',now,1000,'free')];
  let t=analyze(data([paid,later1],views)).totals;assert.equal(t.costPages,1);assert.equal(t.costPerMillion,2_500_000);
  t=analyze(data([paid,free],views)).totals;assert.equal(t.costPages,2,'a page set to ₹0 is free, not unpaid');assert.equal(t.costPerMillion,1_250_000);
  const a=comparablePage('a');a.accounts=[account(at('2026-10-15'),1000,'a'),account(at('2026-10-25'),1010,'a')];
  const h=analyze(data([a.p],a.snapshots,a.accounts)).pages[0];
  assert.equal(h.health.components.find(c=>c.key==='growth').value,0.01*30/10,'growth is per 30 recorded days');
  assert.equal(h.health.components.find(c=>c.key==='activity').value,h.metrics.postsPerDay);
  const short=comparablePage('s');short.accounts=[account(at('2026-10-24'),1000,'s'),account(now,1010,'s')];
  assert.equal(analyze(data([short.p],short.snapshots,short.accounts)).pages[0].health.components.find(c=>c.key==='growth').value,null,'two days of follower history are too short to extrapolate');
  const rated=analyze(data([page('page',[post('m',at('2026-10-20'),{views:100,likes:1,comments:0,saves:50}),post('n',at('2026-10-21'),{views:100,likes:5,comments:0,saves:0})],{platform:'tiktok'})])).pages[0].posts;
  assert.equal(Object.fromEntries(contentStandouts(rated).map(s=>[s.key,s]))['most-engaging'].post.id,'n','latest engagement uses the day-7 definition without saves');
});

test('content standouts cover each best and worst metric with day-7 values and a labelled fallback',()=>{
  const posts=[post('a',at('2026-10-01'),{views:1000,shares:10,saves:4}),post('b',at('2026-10-02'),{views:3000,shares:60,saves:1}),post('c',at('2026-10-03'),{views:500,shares:20,saves:9})];
  const report=analyze(data([page('page',posts,{platform:'tiktok'})],[snap('a',at('2026-10-08'),800,'page',{shares:8,saves:3}),snap('b',at('2026-10-09'),2000,'page',{shares:40,saves:1})]));
  const standouts=Object.fromEntries(contentStandouts(report.pages[0].posts.filter(p=>p.inRange)).map(s=>[s.key,s]));
  assert.equal(standouts['most-viewed'].post.id,'b');assert.equal(standouts['most-viewed'].basis,'day-7');
  assert.equal(standouts['most-saved'].post.id,'a');assert.equal(standouts['least-viewed'].post.id,'a');assert.equal(standouts['lowest-share-rate'].post.id,'a');
  assert.equal(standouts['most-followers'].post,null);assert.match(standouts['most-followers'].note,/does not attribute/);
  const latest=Object.fromEntries(contentStandouts(analyze(data([page('page',posts)])).pages[0].posts).map(s=>[s.key,s]));
  assert.equal(latest['most-viewed'].basis,'latest');assert.equal(latest['most-viewed'].post.id,'b');assert.equal(latest['least-viewed'].post.id,'c');
  assert.equal(latest['most-saved'].post.id,'c');assert.equal(latest['below-baseline'].post,null);
});

test('month-over-month changes cover pay, views, posts, cost per 1K and views per post; month-to-date compares the same days',()=>{
  assert.deepEqual(sameDaysPreviousMonth({from:'2026-10-01',to:'2026-10-29'}),{from:'2026-09-01',to:'2026-09-29'});
  assert.deepEqual(sameDaysPreviousMonth({from:'2026-03-01',to:'2026-03-31'}),{from:'2026-02-01',to:'2026-02-28'});
  const p=post('old',at('2026-07-01')),born=post('born',at('2026-10-05'));
  const report=analyze(data([page('page',[p,born])],[snap('old',at('2026-08-01'),0),snap('old',at('2026-09-01'),24_000),snap('old',at('2026-10-01'),62_000),snap('old',at('2026-10-20'),70_000)]),{from:'2026-08-01',to:'2026-10-25'});
  const [aug,sep,oct]=report.monthly;
  assert.equal(aug.change,null);assert.equal(sep.change.against,'previous-month');assert.equal(sep.change.partial,false);
  assert.equal(sep.change.metrics.views.current,38_000);assert.equal(sep.change.metrics.views.previous,24_000);assert.equal(sep.change.metrics.pay.percent,0);
  assert.equal(sep.change.metrics.costPerThousand.current,3100/38);
  assert.equal(oct.partial,true);assert.deepEqual(oct.sameDays.range,{from:'2026-09-01',to:'2026-09-25'});assert.equal(oct.change.against,'same-days');
  assert.equal(oct.change.metrics.posts.current,1);assert.equal(oct.change.metrics.viewsPerPost.current,8000);
  assert.deepEqual(monthlyChanges(report.monthly),report.monthly.map(row=>row.change));
});

test('distribution score blends health with cost efficiency for ranking',()=>{
  const a=comparablePage('a'),b=comparablePage('b');b.p.monthlyPay=31_000;
  const views=[];for(const x of [a,b])for(const p of x.p.posts)if(p.id.startsWith('10-'))views.push(snap(p.id,at('2026-10-01'),0,x.p.id),snap(p.id,now,10_000,x.p.id));
  const report=analyze(data([a.p,b.p],[...a.snapshots,...b.snapshots,...views],[...a.accounts,...b.accounts]));
  const [ra,rb]=report.pages;assert.equal(ra.health.score,rb.health.score);
  assert.ok(ra.costEfficiency>rb.costEfficiency);assert.ok(ra.distributionScore>rb.distributionScore);
  assert.equal(report.platforms[0].rankings[0].page.id,'a');
  const unpaid=analyze(data([{...a.p,monthlyPay:null}],a.snapshots,a.accounts)).pages[0];assert.equal(unpaid.distributionScore,unpaid.health.score);
  const solo=analyze(data([a.p],[...a.snapshots,...views.filter(v=>v.pageId==='a')],a.accounts)).pages[0],vpt=solo.metrics.viewsPerThousand;
  assert.ok(vpt>0);assert.equal(solo.costEfficiency,Math.round(Math.min(100,Math.max(0,70+30*Math.log2(vpt/200_000)))*10)/10,'₹5 per 1K views (200,000 views per ₹1,000) scores 70');
});

test('quiet-day alerts use the page or workspace setting and name the gap',()=>{
  const d=alertData();d.pages[0].posts=d.pages[0].posts.filter(p=>p.id!=='young');
  assert.equal(ALERT_RULES.quietDays,7);
  let alert=alertCandidates(d,now).find(a=>a.type==='no-posts');assert.equal(alert.title,'No post in 7 days');assert.match(alert.details,/8 days ago/);
  assert.equal(alertCandidates(d,now,{quietDays:10}).some(a=>a.type==='no-posts'),false);
  d.pages[0].alertQuietDays=3;d.pages[0].posts.push(post('recent-ish',later(now,-4)));
  alert=alertCandidates(d,now,{quietDays:10}).find(a=>a.type==='no-posts');assert.equal(alert.title,'No post in 3 days');
});

test('follower loss, engagement decline and average-view drops raise red alerts with their numbers',()=>{
  const d=alertData();
  for(let i=0;i<3;i++){const published=later(now,-10-i),p=post('more'+i,published);d.pages[0].posts.push(p);d.postSnapshots.push(snap(p.id,later(published,7),40,'page',{likes:0,comments:0}));}
  for(const s of d.postSnapshots)if(s.postId.startsWith('recent')){s.likes=0;s.comments=0;}
  d.accountSnapshots.push(account(later(now,-8),5000),account(later(now,-1),4800));
  const alerts=alertCandidates(d,now),find=type=>alerts.find(a=>a.type===type);
  assert.match(find('follower-loss').details,/5,000 to 4,800/);assert.equal(find('follower-loss').level,'red');
  assert.equal(find('engagement-drop').level,'red');assert.match(find('engagement-drop').details,/6\.0% to 0\.0%/);
  assert.equal(find('average-drop').level,'red');assert.match(find('average-drop').details,/\(100 → 44\)/);
  assert.match(find('median-drop').details,/\(100 → 40\)/);
  assert.match(alertCandidates(alertData(),now).find(a=>a.type==='posting-drop').details,/^2 posts in the latest matured week against 5/);
  const small=alertData();small.accountSnapshots.push(account(later(now,-8),50_000),account(later(now,-1),49_990));
  assert.equal(alertCandidates(small,now).some(a=>a.type==='follower-loss'),false,'rounding noise is not a loss');
});

test('only the strongest viral post per page is kept and it is named; unchecked pages are listed',()=>{
  const d=alertData();d.postSnapshots.find(s=>s.postId==='recent0').views=600;d.postSnapshots.find(s=>s.postId==='recent1').views=900;
  const viral=alertCandidates(d,now).filter(a=>a.type==='viral-post');
  assert.equal(viral.length,1);assert.equal(viral[0].postId,'recent1');assert.match(viral[0].details,/recent1/);assert.match(viral[0].details,/9\.0×/);
  const stale=alertData();stale.pages[0].lastSyncedAt=later(now,-5);
  assert.deepEqual(alertCheck(stale,now).unchecked.map(u=>u.pageId),['page']);
  assert.deepEqual(alertCheck(alertData(),now).unchecked,[]);
});

test('content type labels follow the spec names',()=>{
  assert.equal(contentTypeLabel('instagram','video'),'Reel');assert.equal(contentTypeLabel('instagram','image'),'Post');assert.equal(contentTypeLabel('instagram','carousel'),'Carousel');
  assert.equal(contentTypeLabel('youtube','short'),'Short');assert.equal(contentTypeLabel('youtube','video',45),'Short');assert.equal(contentTypeLabel('youtube','video',600),'Video');
  assert.equal(contentTypeLabel('tiktok','video'),'Video');assert.equal(contentTypeLabel('tiktok',null),'Video');assert.equal(contentTypeLabel('instagram',null),'Unknown type');
});
