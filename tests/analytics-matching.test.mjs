import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeCaption, captionTokens, textSimilarity, suggestMatches, contentMatrix, applyContentLinks, contentTitle, linkKey, isContentGroup, MATCH_RULES} from '../lib/analytics/matching.ts';

const DAY=86_400_000;
const at=(day,hours=0)=>new Date(Date.parse(day+'T00:00:00Z')+hours*3_600_000).toISOString();
const post=(id,title,publishedAt,values={})=>({id,url:'https://instagram.com/p/'+id,title,publishedAt,thumbnail:null,durationSeconds:34.2,views:100,likes:null,comments:null,shares:null,saves:null,type:'reel',sourceAssetId:null,audioId:null,...values});
const page=(id,posts,platform='instagram')=>({id,platform,handle:id,url:'',name:id,followers:null,lastSyncedAt:null,syncError:null,posts:posts.map(p=>({...p,pageId:id})),monthlyPay:null,editor:'',startDate:null,active:true,notes:''});
const ids=suggestion=>suggestion.members.map(member=>member.pageId+':'+member.postId);
const metro='Why the metro beats the road at rush hour';

test('captions are normalized before comparing: case, URLs, hashtags, mentions, emoji, punctuation and call-to-action lines',()=>{
  assert.equal(normalizeCaption('Why the METRO beats the road… at rush-hour! 🚇👀 #learn #shorts @studio.north\nFollow for more'),'why the metro beats the road at rush hour');
  assert.equal(normalizeCaption('See https://example.com/x and www.example.org   now'),'see and now');
  assert.equal(normalizeCaption('What’s inside   a phone\'s battery?'),'whats inside a phones battery');
  assert.equal(normalizeCaption('Ｆｕｌｌ　width'),'full width','NFKC folds full-width text');
  assert.equal(normalizeCaption('Follow the money: how tea is priced'),'follow the money how tea is priced','A first line is the caption, even when it starts like a call to action');
  assert.equal(normalizeCaption('Photo by Studio North on May 3, 2026. May be an image of text'),'','Instagram alt text is not a caption');
  assert.equal(normalizeCaption(null),'');
  assert.deepEqual(captionTokens(metro+' #learn'),['metro','beats','road','rush','hour']);
  assert.equal(textSimilarity(captionTokens(metro),captionTokens(metro+'\nFollow for more 👀')),1);
  assert.equal(textSimilarity(['wait'],['wait']),null,'Captions that are too short are unknown, not a match');
  const longer=textSimilarity(captionTokens(metro),captionTokens(metro+' and what it costs every month'));
  assert.ok(longer>.6&&longer<1,'An added sentence lowers the score without hiding the match');
});

test('the same content on different pages is suggested with a confidence score and reasons, never linked',()=>{
  const pages=[page('a',[post('a1',metro+' #learn',at('2026-10-01'))]),page('b',[post('b1',metro+'\nFollow for more',at('2026-10-02',6),{durationSeconds:34.24})],'tiktok'),page('c',[post('c1','A completely different video about tea',at('2026-10-01'))])];
  const [suggestion,...rest]=suggestMatches(pages);
  assert.equal(rest.length,0);
  assert.deepEqual(ids(suggestion),['a:a1','b:b1']);
  assert.equal(suggestion.band,'likely');assert.ok(suggestion.score>=MATCH_RULES.likely&&suggestion.score<=1);
  assert.equal(suggestion.groupId,null);
  assert.deepEqual(suggestion.reasons,['Caption 100% match','34.2 s vs 34.24 s','1.3 days apart']);
  assert.equal(pages[0].posts[0].sourceAssetId,null,'Suggesting never changes a post');
});

test('hard gates: same page, duration, publish window and format',()=>{
  const twin=(values={},other={})=>suggestMatches([page('a',[post('a1',metro,at('2026-10-01'),values)]),page('b',[post('b1',metro,at('2026-10-02'),other)])]);
  assert.equal(suggestMatches([page('a',[post('a1',metro,at('2026-10-01')),post('a2',metro,at('2026-10-02'))])]).length,0,'Two posts on one page are never matched');
  assert.equal(twin({durationSeconds:45.1},{durationSeconds:52}).length,0,'45.1 s vs 52.0 s is different content');
  assert.equal(twin({durationSeconds:600},{durationSeconds:615}).length,1,'Long videos allow 3% re-encoding drift');
  assert.equal(twin({},{publishedAt:at('2026-10-23')}).length,0,'More than 21 days apart');
  assert.equal(twin({},{publishedAt:at('2026-10-21')}).length,1,'20 days apart is still in the window');
  assert.equal(twin({type:'carousel',durationSeconds:null},{type:'reel'}).length,0,'A carousel never matches a reel');
  assert.equal(twin({type:'short'},{type:'video'}).length,1,'Shorts, reels and videos are one kind');
  assert.equal(twin({durationSeconds:null,type:null},{durationSeconds:null}).length,1,'Unknown lengths and types fall back to caption and date');
  assert.equal(twin({},{title:'A street vendor prices a cup of tea in Kolkata'}).length,0,'Different captions are not suggested');
});

test('without a usable caption only a near-identical length or the same audio counts, and only as a possible match',()=>{
  const blind=(other={},values={})=>suggestMatches([page('a',[post('a1','🔥🔥',at('2026-10-01'),{durationSeconds:27.512,...values})]),page('b',[post('b1','',at('2026-10-03'),{durationSeconds:27.55,...other})])]);
  const [only]=blind();
  assert.equal(only.band,'possible');assert.ok(only.score<=MATCH_RULES.blindCap&&only.score>=MATCH_RULES.possible);
  assert.match(only.reasons[0],/Caption too short/);
  assert.equal(blind({durationSeconds:27.7}).length,0,'0.19 s apart is not enough without words');
  assert.equal(blind({publishedAt:at('2026-10-09')}).length,0,'More than 7 days apart without words');
  const captioned=blind({},{title:metro});
  assert.equal(captioned.length,1,'A captionless repost of a captioned post is still compared by length');assert.equal(captioned[0].band,'possible');
  assert.equal(blind({durationSeconds:27.7},{title:metro}).length,0);
  const weak=[page('a',[post('a1',metro,at('2026-10-01'))]),page('b',[post('b1',metro,at('2026-10-02'))]),page('c',[post('c1','',at('2026-10-01',3),{durationSeconds:34.25})])];
  assert.deepEqual(suggestMatches(weak).map(ids),[['a:a1','b:b1']],'A possible pair never pulls a likely group down');
  const joined=suggestMatches(applyContentLinks({pages:weak},{[linkKey('a','a1')]:'ca_x',[linkKey('b','b1')]:'ca_x'}).pages);
  assert.equal(joined.length,1);assert.equal(joined[0].groupId,'ca_x');assert.equal(joined[0].band,'possible');assert.ok(ids(joined[0]).includes('c:c1'));
  const audio=blind({durationSeconds:27.9,audioId:'sound-1'},{audioId:'sound-1'});
  assert.equal(audio.length,1);assert.ok(audio[0].reasons.includes('Same audio'));
  const withText=suggestMatches([page('a',[post('a1',metro,at('2026-10-01'),{audioId:'x'})]),page('b',[post('b1',metro+' and the bus',at('2026-10-08'),{audioId:'x'})])]);
  const withoutAudio=suggestMatches([page('a',[post('a1',metro,at('2026-10-01'))]),page('b',[post('b1',metro+' and the bus',at('2026-10-08'))])]);
  assert.ok(withText[0].score>withoutAudio[0].score,'Shared audio is a bonus');
});

test('groups hold one post per page, join confirmed groups, and skip posts marked unique',()=>{
  // Page a reposted the same video twice; the group keeps only the closer copy.
  const [group]=suggestMatches([page('a',[post('a1',metro,at('2026-10-01')),post('a2',metro,at('2026-10-15'))]),page('b',[post('b1',metro,at('2026-10-02'))]),page('c',[post('c1',metro,at('2026-10-02',12))])]);
  assert.deepEqual(ids(group),['a:a1','b:b1','c:c1']);
  const anchored=suggestMatches([page('a',[post('a1',metro,at('2026-10-01'),{sourceAssetId:'ca_one'})]),page('b',[post('b1',metro,at('2026-10-02'),{sourceAssetId:'ca_one'})]),page('c',[post('c1',metro,at('2026-10-03'))]),page('d',[post('d1',metro,at('2026-10-03'),{sourceAssetId:'solo_x'})])]);
  assert.equal(anchored.length,1);
  assert.equal(anchored[0].groupId,'ca_one');
  assert.deepEqual(anchored[0].members.map(member=>[member.pageId,member.linked]),[['a',true],['b',true],['c',false]]);
  // A confirmed group already has page b, so b's other copy cannot join it.
  const occupied=suggestMatches([page('a',[post('a1',metro,at('2026-10-01'),{sourceAssetId:'ca_one'})]),page('b',[post('b0','Something else entirely about buses',at('2026-09-01'),{sourceAssetId:'ca_one'}),post('b1',metro,at('2026-10-02'))])]);
  assert.equal(occupied.length,0);
  assert.equal(suggestMatches([page('a',[post('a1',metro,at('2026-10-01'),{sourceAssetId:'ca_one'})]),page('b',[post('b1',metro,at('2026-10-02'),{sourceAssetId:'ca_two'})])]).length,0,'Two confirmed groups never merge');
  assert.equal(suggestMatches([page('a',[post('a1',metro,at('2026-10-01'))]),page('b',[post('b1',metro,at('2026-10-02'),{sourceAssetId:'solo_1'})])]).length,0);
  assert.ok(isContentGroup('ca_x')&&!isContentGroup('solo_x')&&!isContentGroup(null));
});

test('local link changes overlay the loaded history without touching other posts',()=>{
  const dataset={pages:[page('a',[post('a1',metro,at('2026-10-01')),post('a2','x',at('2026-10-01'))])],generatedAt:'now'};
  assert.equal(applyContentLinks(dataset,{}),dataset);
  const next=applyContentLinks(dataset,{[linkKey('a','a1')]:'ca_new'});
  assert.equal(next.pages[0].posts[0].sourceAssetId,'ca_new');assert.equal(next.pages[0].posts[1],dataset.pages[0].posts[1]);
  assert.equal(dataset.pages[0].posts[0].sourceAssetId,null);
  assert.equal(applyContentLinks(next,{[linkKey('a','a1')]:null}).pages[0].posts[0].sourceAssetId,null);
  assert.equal(contentTitle(metro+' #learn @x 👀\nFollow for more'),metro);
});

test('the matrix reproduces the spec example: rows are content, columns pages, with row totals, page totals and best page',()=>{
  const analyzed=(pageId,id,group,views,values={})=>({...post(id,'Content '+group,at('2026-10-01'),{views,sourceAssetId:'ca_'+group}),pageId,pagePlatform:'instagram',pageName:pageId,inRange:true,viewsGained:views,fixedAgeViews:views===null?null:views/2,...values});
  const spec=[['1',[450e3,210e3,82e3,640e3]],['2',[120e3,390e3,55e3,210e3]],['3',[890e3,510e3,220e3,1.1e6]]];
  const pages=['A','B','C','D'].map((id,column)=>({page:{id},posts:spec.map(([group,values])=>analyzed(id,id+group,group,values[column]))}));
  pages.push({page:{id:'E'},posts:[analyzed('E','E9','solo',5,{sourceAssetId:'solo_1'}),analyzed('E','E8','alone',9)]});
  const matrix=contentMatrix(pages,'published');
  assert.deepEqual(matrix.rows.map(row=>[row.title,row.total]),[['Content 3',2.72e6],['Content 1',1.382e6],['Content 2',775e3]]);
  assert.deepEqual(matrix.pageIds,['A','B','C','D'],'Only pages that carry linked content are columns; a single-post group is not a row');
  assert.equal(matrix.pageTotals.get('A'),1.46e6);assert.equal(matrix.total,2.72e6+1.382e6+775e3);
  assert.deepEqual([...matrix.wins],[['A',0],['B',1],['C',0],['D',2]]);
  assert.equal(matrix.rows[0].best,'D');
  assert.equal(contentMatrix(pages,'day7').rows[0].total,1.36e6,'Day-7 mode uses the fixed-age views');
  // Unknown views stay unknown: the total adds only known cells and says how many.
  pages[0].posts[0].views=null;
  const partial=contentMatrix(pages,'published').rows.find(row=>row.groupId==='ca_1');
  assert.equal(partial.total,932e3);assert.equal(partial.known,3);assert.equal(partial.cells.get('A').value,null);
  for(const row of pages)for(const item of row.posts)item.inRange=false;
  assert.equal(contentMatrix(pages,'published').rows.length,0,'Groups with no post in the dates are left out');
  assert.equal(contentMatrix(pages,'gained').rows.length,3,'…unless their posts gained views in the dates');
});

test('matching 50,000 posts stays fast because pairs are only scored inside blocks',()=>{
  const words='alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu'.split(' ');
  const pages=Array.from({length:500},(_,p)=>page('p'+p,Array.from({length:100},(_,i)=>{
    const n=p*100+i, title=[0,1,2,3,4].map(k=>words[(n*(k+3)+k*7)%words.length]+((n>>k)%97)).join(' ');
    return post('p'+p+'-'+i,title,new Date(Date.parse('2026-01-01')+((n*7919)%(270*DAY))).toISOString(),{durationSeconds:15+(n*37%600)/10});
  })));
  // Twenty pieces of content (similar captions, different lengths) reposted on three pages each.
  for(let k=0;k<20;k++)for(const p of [k,k+100,k+200])pages[p].posts.push({...post('shared-'+k,'Shared lesson number '+k+' about compound interest and savings',at('2026-05-01',k+p/100),{durationSeconds:20+k*3}),pageId:'p'+p});
  const started=performance.now(), suggestions=suggestMatches(pages), elapsed=performance.now()-started;
  assert.ok(elapsed<10_000,`took ${Math.round(elapsed)} ms`);
  const shared=suggestions.filter(item=>item.members.some(member=>member.postId.startsWith('shared-')));
  assert.equal(shared.length,20);assert.ok(shared.every(item=>item.members.length===3&&item.band==='likely'));
});
