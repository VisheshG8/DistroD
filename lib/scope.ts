/** Public counters on posts published in an interval; these are not period-earned views. */
export type Scope = { mode:'posts'|'date'; postLimit:number; from:string|null; to:string|null };
export type ScopeCoverage = {
  limit?:number; fetched?:number; hasMore?:boolean; incomplete?:boolean; complete?:boolean;
  scopeKey?:string; requestedMode?:'posts'|'date'; from?:string|null; to?:string|null;
  oldest?:string|null; newest?:string|null; unknownDates?:number; scanned?:number; stopReason?:string;
  snapshotAt?:string|null; snapshotPosts?:number; profilePostCount?:number|null;
};
export const DEFAULT_SCOPE:Scope={mode:'posts',postLimit:30,from:null,to:null};
export function normalizeScope(value:unknown, fallback=30):Scope {
  if(value===undefined||value===null)return {mode:'posts',postLimit:fallback,from:null,to:null};
  if(typeof value!=='object'||Array.isArray(value))throw new Error('Choose a post count or a date range.');
  const v=value as Record<string,unknown>;
  if(v.mode==='posts'){
    const n=Number(v.postLimit);
    if(!Number.isInteger(n)||n<1||n>1000)throw new Error('Choose between 1 and 1,000 recent posts per page.');
    return {mode:'posts',postLimit:n,from:null,to:null};
  }
  if(v.mode!=='date'||typeof v.from!=='string'||typeof v.to!=='string')throw new Error('Choose a valid start and end date.');
  if(!/^\d{4}-\d{2}-\d{2}T/.test(v.from)||!/^\d{4}-\d{2}-\d{2}T/.test(v.to))throw new Error('Choose valid start and end dates.');
  dayTime(v.from.slice(0,10));dayTime(v.to.slice(0,10));
  const from=new Date(v.from),to=new Date(v.to);
  if(!Number.isFinite(from.getTime())||!Number.isFinite(to.getTime())||from>=to)throw new Error('The end date must be on or after the start date.');
  return {mode:'date',postLimit:1000,from:from.toISOString(),to:to.toISOString()};
}
function dayTime(day:string){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw new Error('Choose a valid calendar date.');
  const [y,m,d]=day.split('-').map(Number),time=Date.UTC(y,m-1,d);
  if(new Date(time).toISOString().slice(0,10)!==day)throw new Error('Choose a valid calendar date.');
  return time-330*60*1000;
}
/** Both visible dates are inclusive India calendar dates. Server intervals are [from,to). */
export function scopeFromDates(fromDay:string,toDay:string):Scope {
  return normalizeScope({mode:'date',from:new Date(dayTime(fromDay)).toISOString(),to:new Date(dayTime(toDay)+86400000).toISOString()});
}
export function scopeKey(scope:Scope){return scope.mode==='posts'?`posts:${scope.postLimit}`:`date:${scope.from}:${scope.to}`;}
export function storedScope(coverage:ScopeCoverage):Scope {
  if(coverage.requestedMode==='date'&&coverage.from&&coverage.to)return {mode:'date',postLimit:1000,from:coverage.from,to:coverage.to};
  return {mode:'posts',postLimit:coverage.limit||30,from:null,to:null};
}
export function selectPosts<T extends {publishedAt:string|null}>(posts:T[],scope:Scope):T[]{
  if(scope.mode==='posts')return posts.slice(0,scope.postLimit);
  const from=Date.parse(scope.from!),to=Date.parse(scope.to!);
  return posts.filter(p=>{const t=p.publishedAt?Date.parse(p.publishedAt):NaN;return t>=from&&t<to;});
}
function hasSnapshot(coverage:ScopeCoverage){return typeof coverage.scopeKey==='string'||typeof coverage.fetched==='number';}
export function snapshotMatches(coverage:ScopeCoverage,scope:Scope){return hasSnapshot(coverage)&&(coverage.scopeKey||scopeKey(storedScope(coverage)))===scopeKey(scope);}
function knownCount(value:unknown):value is number{return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;}
/** A historical window cannot stand in for the latest posts at refresh time. */
function dateSnapshotReachesRefresh(coverage:ScopeCoverage):boolean {
  if(coverage.requestedMode!=='date'||!coverage.from||!coverage.to||!coverage.snapshotAt)return false;
  const from=Date.parse(coverage.from),to=Date.parse(coverage.to),at=Date.parse(coverage.snapshotAt);
  return Number.isFinite(from)&&Number.isFinite(to)&&Number.isFinite(at)&&from<=at&&to>=at&&from<to;
}
/** Complete traversal and public metric availability are intentionally separate. */
export function snapshotCovers(coverage:ScopeCoverage,scope:Scope):boolean {
  if(!hasSnapshot(coverage))return false;
  const saved=storedScope(coverage);
  const complete=coverage.complete??(!coverage.hasMore||Number(coverage.fetched)>=Number(coverage.limit||30));
  if(!complete)return false;
  if(scope.mode==='posts'){
    if(saved.mode==='posts')return scope.postLimit<=saved.postLimit||coverage.hasMore===false;
    if(!dateSnapshotReachesRefresh(coverage)||coverage.unknownDates||!knownCount(coverage.snapshotPosts))return false;
    return coverage.snapshotPosts>=scope.postLimit||(coverage.hasMore===false&&knownCount(coverage.profilePostCount)&&coverage.snapshotPosts>=coverage.profilePostCount);
  }
  if(coverage.unknownDates)return false;
  if(saved.mode==='date')return !!saved.from&&!!saved.to&&Date.parse(saved.from)<=Date.parse(scope.from!)&&Date.parse(saved.to)>=Date.parse(scope.to!);
  if(coverage.hasMore===false)return true;
  return !!coverage.oldest&&Date.parse(coverage.oldest)<Date.parse(scope.from!);
}
export function snapshotCanDisplay(coverage:ScopeCoverage,scope:Scope){
  return snapshotMatches(coverage,scope)||snapshotCovers(coverage,scope)||
    (hasSnapshot(coverage)&&scope.mode==='posts'&&dateSnapshotReachesRefresh(coverage)&&knownCount(coverage.snapshotPosts)&&coverage.snapshotPosts>0);
}
export function postDates(posts:{publishedAt:string|null}[]){
  const dates=posts.map(p=>p.publishedAt).filter((d):d is string=>!!d&&Number.isFinite(Date.parse(d))).sort();
  return {oldest:dates[0]||null,newest:dates.at(-1)||null,unknownDates:posts.length-dates.length};
}
export function dateInput(iso:string){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(iso));}
