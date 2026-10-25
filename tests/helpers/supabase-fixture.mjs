import {createClient} from '@supabase/supabase-js';

const identifier=value=>{if(!/^[a-z_][a-z0-9_]*$/i.test(value))throw new Error('Unexpected SQL identifier in test API: '+value);return '"'+value+'"';};
const json=value=>JSON.stringify(value,(_key,item)=>typeof item==='bigint'?Number(item):item);

/** The real Supabase SDK creates requests; this small PostgREST transport
 * executes their filters, mutations and named RPCs in PostgreSQL. Unsupported
 * requests fail explicitly rather than silently returning simulated data. */
export function testSupabase(pg,{beforeRpc}={}){
  const calls=[];
  const transport=async(input,init={})=>{
    const request=input instanceof Request?input:new Request(input,init),url=new URL(request.url);
    const table=url.pathname.replace(/^\/rest\/v1\//,''),headers=new Headers(request.headers),method=request.method;
    calls.push({method,path:url.pathname,search:url.search,body:request.body?await request.clone().json():null});
    try{
      if(table.startsWith('rpc/')){
        const name=table.slice(4),args=await request.json();
        if(beforeRpc)await beforeRpc(name,args);
        const entries=Object.entries(args),parameters=entries.map(([,value])=>value&&typeof value==='object'?JSON.stringify(value):value);
        const named=entries.map(([name],i)=>identifier(name)+' => $'+(i+1)).join(',');
        const response=await pg.transaction(async tx=>{await tx.exec('set local role service_role');return tx.query('select public.'+identifier(name)+'('+named+') as result',parameters);});
        return new Response(json(response.rows[0]?.result??null),{status:200,headers:{'Content-Type':'application/json'}});
      }
      identifier(table);
      const parameters=[],bind=value=>{parameters.push(value);return '$'+parameters.length;};
      const filters=[];
      for(const [field,filter] of url.searchParams){
        if(['select','order','limit','offset','on_conflict'].includes(field))continue;
        if(field==='or'||field==='and')throw new Error('Logical PostgREST filters not implemented in test transport');
        const column=identifier(field),match=filter.match(/^(eq|neq|lt|lte|gt|gte|is|in|not\.is)\.(.*)$/s);
        if(!match)throw new Error('Unsupported PostgREST filter: '+filter);
        const [,operation,value]=match;
        if(operation==='is'||operation==='not.is'){
          if(!['null','true','false'].includes(value))throw new Error('Unsupported is filter');
          filters.push(column+(operation==='not.is'?' is not ':' is ')+value);
        }else if(operation==='in'){
          if(!value.startsWith('(')||!value.endsWith(')'))throw new Error('Malformed in filter');
          const values=value.slice(1,-1).split(',').filter(Boolean).map(item=>item.replace(/^"|"$/g,''));
          filters.push(values.length?column+' in ('+values.map(bind).join(',')+')':'false');
        }else filters.push(column+' '+({eq:'=',neq:'<>',lt:'<',lte:'<=',gt:'>',gte:'>='}[operation])+' '+bind(value));
      }
      const selection=url.searchParams.get('select')||'*';
      const columns=selection==='*'?'*':selection.split(',').map(part=>{
        const [alias,column]=part.split(':');return column?identifier(column)+' as '+identifier(alias):identifier(alias);
      }).join(',');
      const where=filters.length?' where '+filters.join(' and '):'';
      let sql,exactCount=null;
      if(method==='GET'||method==='HEAD'){
        if(headers.get('prefer')?.includes('count=exact'))exactCount=Number((await pg.query('select count(*) as n from public.'+identifier(table)+where,parameters)).rows[0].n);
        sql='select '+columns+' from public.'+identifier(table)+where;
        const order=url.searchParams.get('order');
        if(order)sql+=' order by '+order.split(',').map(part=>{const [field,...options]=part.split('.');return identifier(field)+(options.includes('desc')?' desc':' asc')+(options.includes('nullslast')?' nulls last':options.includes('nullsfirst')?' nulls first':'');}).join(',');
        const limit=url.searchParams.get('limit'),offset=url.searchParams.get('offset');
        // Match Supabase's default 1,000-row Data API cap, including requests
        // which omit an explicit range. This catches accidental truncation.
        sql+=' limit '+bind(limit?Math.min(1000,Number(limit)):1000);if(offset)sql+=' offset '+bind(Number(offset));
      }else if(method==='POST'){
        const body=await request.json(),rows=Array.isArray(body)?body:[body],keys=Object.keys(rows[0]||{});
        if(!keys.length)throw new Error('Empty insert not supported');
        sql='insert into public.'+identifier(table)+' ('+keys.map(identifier).join(',')+') values '+rows.map(row=>'('+keys.map(key=>bind(row[key]&&typeof row[key]==='object'?JSON.stringify(row[key]):row[key])).join(',')+')').join(',');
        const prefer=headers.get('prefer')||'',conflict=url.searchParams.get('on_conflict');
        if(prefer.includes('resolution=ignore-duplicates'))sql+=' on conflict'+(conflict?' ('+conflict.split(',').map(identifier).join(',')+')':'')+' do nothing';
        if(prefer.includes('resolution=merge-duplicates'))sql+=' on conflict ('+(conflict||'id').split(',').map(identifier).join(',')+') do update set '+keys.filter(key=>!(conflict||'id').split(',').includes(key)).map(key=>identifier(key)+'=excluded.'+identifier(key)).join(',');
        sql+=' returning '+columns;
      }else if(method==='PATCH'){
        const body=await request.json();
        sql='update public.'+identifier(table)+' set '+Object.entries(body).map(([key,value])=>identifier(key)+'='+bind(value&&typeof value==='object'?JSON.stringify(value):value)).join(',')+where+' returning '+columns;
      }else if(method==='DELETE')sql='delete from public.'+identifier(table)+where+' returning '+columns;
      else throw new Error('Unsupported test API method: '+method);
      const result=await pg.transaction(async tx=>{await tx.exec('set local role service_role');return tx.query(sql,parameters);});
      const object=headers.get('accept')?.includes('application/vnd.pgrst.object+json'),returning=method==='GET'||headers.get('prefer')?.includes('return=representation');
      if(object&&result.rows.length!==1)return new Response(json({code:'PGRST116',message:'JSON object requested, multiple (or no) rows returned',details:'The result contains '+result.rows.length+' rows'}),{status:406,headers:{'Content-Type':'application/json'}});
      const responseHeaders={'Content-Type':'application/json'};
      if(exactCount!==null)responseHeaders['Content-Range']='0-'+Math.max(0,result.rows.length-1)+'/'+exactCount;
      return new Response(method==='HEAD'?null:returning?json(object?result.rows[0]:result.rows):null,{status:method==='POST'?201:method==='GET'||method==='HEAD'||returning?200:204,headers:responseHeaders});
    }catch(error){return new Response(json({code:error.code||'TEST_TRANSPORT',message:error.message,details:null,hint:null}),{status:400,headers:{'Content-Type':'application/json'}});}
  };
  return {client:createClient('http://127.0.0.1:54321','test-backend-key',{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:transport}}),calls};
}
