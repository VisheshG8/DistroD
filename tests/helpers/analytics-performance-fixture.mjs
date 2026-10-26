/** Deterministic synthetic history; no external services or saved customer data. */
export function analyticsPerformanceFixture(pageCount=3,postsPerPage=30){
  const DAY=86_400_000,now=Date.parse('2026-10-26T00:00:00Z');
  const stamp=value=>new Date(value).toISOString();
  const dataset={pages:[],accountSnapshots:[],postSnapshots:[],alerts:[],generatedAt:stamp(now)};
  for(let p=0;p<pageCount;p++){
    const id='page-'+p,platform=['instagram','youtube','tiktok'][p%3];
    const page={id,platform,handle:id,url:'',name:id,followers:1000+p*100,lastSyncedAt:stamp(now),syncError:null,posts:[],monthlyPay:3000+p*100,editor:'Editor '+p,startDate:'2026-01-01',active:true,notes:''};
    dataset.pages.push(page);
    for(let i=0;i<postsPerPage;i++){
      const postId='post-'+i,published=now-(9+i%180)*DAY;
      const post={id:postId,pageId:id,platform,url:'',title:postId,publishedAt:stamp(published),observedAt:stamp(now),thumbnail:null,durationSeconds:20,views:i%13===0?null:(i+1)*1000,likes:20+i,comments:4,shares:null,saves:null};
      page.posts.push(post);
      for(const age of [0,1,3,7,8,14,30,60,90,120,150,180]){
        const observed=published+age*DAY;
        if(observed>now)continue;
        dataset.postSnapshots.push({pageId:id,postId,observedAt:stamp(observed),views:i%13===0?null:Math.max(0,(i+1)*age*5-(age===30?300:0)),likes:20+i,comments:4,shares:null,saves:null});
      }
    }
    for(let day=200;day>=0;day--)dataset.accountSnapshots.push({pageId:id,observedAt:stamp(now-day*DAY),followers:Math.max(0,page.followers-day),following:null,postCount:postsPerPage});
    dataset.alerts.push({id:'alert-'+p,pageId:id,level:'amber',type:'data-health',title:'Saved alert',details:'',createdAt:stamp(now),resolvedAt:null});
  }
  return dataset;
}
export const performanceRange={from:'2026-07-01',to:'2026-10-25'};
export const performanceComparison={from:'2026-04-01',to:'2026-06-30'};
