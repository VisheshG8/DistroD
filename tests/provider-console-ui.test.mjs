import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {Script} from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

const require=createRequire(import.meta.url);
const code=ts.transpileModule(readFileSync(new URL('../components/provider-console.tsx',import.meta.url),'utf8'),{
  compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText;

function harness({configured=false}={}){
  const slots=[],pending=[],requests=[];
  let cursor=0,failNextKey=false,loads=0;
  const response={
    settings:{provider_order:{instagram:['hikerapi','tikhub','scrapecreators'],youtube:['youtube-official','tikhub','scrapecreators'],tiktok:['lamatok','tikhub','scrapecreators']},monthly_request_cap:25000,monthly_budget_usd:25,request_costs:{'instagram-looter':0.000660,hikerapi:0.02,lamatok:0.02,tikhub:0.001,scrapecreators:0.001,'youtube-official':0},refresh_enabled:false,refresh_interval_hours:24},
    keys:{'instagram-looter':configured},schedulerConfigured:false,
    usage:{totals:{requests:0,estimatedCostUsd:0,month:'2026-10'},providers:[]},requests:[],failed:[],
  };
  const hooks={...React,
    useState(initial){const index=cursor++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;return [slots[index],value=>{slots[index]=typeof value==='function'?value(slots[index]):value;}];},
    useEffect(effect,deps){const index=cursor++;const previous=slots[index];if(!previous||deps.some((value,i)=>!Object.is(value,previous.deps[i]))){slots[index]={deps,cleanup:previous?.cleanup};pending.push(()=>{previous?.cleanup?.();slots[index].cleanup=effect();});}},
  };
  const exports={};
  new Script(code,{filename:'provider-console.js'}).runInNewContext({exports,AbortController,console,
    require(name){if(name==='react')return hooks;if(name==='./provider-console.css')return {};if(name==='@/lib/product')return {PRODUCT_NAME:'Distribution Desk'};return require(name);},
    fetch:async(url,options={})=>{
      assert.equal(url,'/api/admin/operations');
      if(options.method!=='POST'){loads++;return Response.json(response);}
      const payload=JSON.parse(options.body);requests.push(payload);
      if(payload.action==='saveRapidApiKey'){
        if(failNextKey){failNextKey=false;return Response.json({error:'Could not save the key. Please retry.'},{status:503});}
        response.keys['instagram-looter']=!payload.clearRapidApiKey;
        return Response.json({ok:true,hasRapidApiKey:response.keys['instagram-looter']});
      }
      return Response.json({ok:true});
    },
  });
  return {requests,get loads(){return loads;},failNextKey(){failNextKey=true;},
    render(){cursor=0;return exports.default();},
    async flush(){while(pending.length)pending.shift()();await new Promise(resolve=>setImmediate(resolve));},
  };
}

function all(node,predicate,result=[]){
  if(!node||typeof node!=='object')return result;
  if(Array.isArray(node)){for(const child of node)all(child,predicate,result);return result;}
  if(predicate(node))result.push(node);
  return all(node.props?.children,predicate,result);
}
function find(node,predicate){const found=all(node,predicate)[0];assert.ok(found,'Expected UI control');return found;}
function text(node){if(typeof node==='string'||typeof node==='number')return String(node);if(Array.isArray(node))return node.map(text).join('');return node&&typeof node==='object'?text(node.props?.children):'';}
function input(tree){return find(tree,node=>node.type==='input'&&node.props.id==='rapidapi-key');}
function button(tree,label){return find(tree,node=>node.type==='button'&&text(node)===label);}
function submit(tree,label){find(tree,node=>node.type==='form'&&node.props['aria-label']===label).props.onSubmit({preventDefault(){}});}
async function loaded(options){const h=harness(options);h.render();await h.flush();return h;}

test('provider console renders a blank masked key field and all four Instagram provider positions',async()=>{
  const h=await loaded({configured:true}),tree=h.render();
  assert.equal(input(tree).props.type,'password');assert.equal(input(tree).props.value,'');
  assert.equal(input(tree).props.autoComplete,'new-password');
  const selects=all(tree,node=>node.type==='select');
  assert.equal(selects.filter(node=>node.props['aria-label'].startsWith('Instagram ')).length,4);
  for(const select of selects.filter(node=>!node.props['aria-label'].startsWith('Instagram '))){
    assert.equal(all(select,node=>node.type==='option'&&node.props.value==='instagram-looter').length,0);
  }
  const html=renderToStaticMarkup(tree);
  assert.match(html,/Key saved securely/);assert.match(html,/default schedule runs once daily/);
  assert.match(html,/https:\/\/rapidapi.com\/irrors-apis\/api\/instagram-looter2\/pricing/);
  assert.doesNotMatch(html,/runs hourly/);
});

test('key save clears the field and preserves unsaved provider order without an extra data reload',async()=>{
  const h=await loaded();
  find(h.render(),node=>node.type==='select'&&node.props['aria-label']==='Instagram fallback 3').props.onChange({target:{value:'instagram-looter'}});
  find(h.render(),node=>node.type==='select'&&node.props['aria-label']==='Instagram primary provider').props.onChange({target:{value:'instagram-looter'}});
  input(h.render()).props.onChange({target:{value:'  fixture-rapidapi-key  '}});
  submit(h.render(),'RapidAPI key settings');await h.flush();
  const saved=h.render();
  assert.equal(input(saved).props.value,'');
  assert.match(renderToStaticMarkup(saved),/Key saved securely/);
  assert.equal(h.loads,1,'Saving a key must not refetch and overwrite unsaved provider settings');
  assert.deepEqual(h.requests[0],{action:'saveRapidApiKey',rapidApiKey:'fixture-rapidapi-key',clearRapidApiKey:false});
  submit(saved,'Provider settings');await h.flush();
  assert.deepEqual(h.requests[1].providerOrder.instagram,['instagram-looter','tikhub','scrapecreators','hikerapi']);
  assert.equal(h.requests[1].refreshEnabled,false,'Saving a key or choosing a provider does not enable scheduling');
  assert.equal('rapidApiKey' in h.requests[1],false);
});

test('failed key save preserves the entered key and other settings submissions never include it',async()=>{
  const h=await loaded();h.failNextKey();
  input(h.render()).props.onChange({target:{value:'fixture-unsaved-secret'}});
  submit(h.render(),'RapidAPI key settings');await h.flush();
  assert.equal(input(h.render()).props.value,'fixture-unsaved-secret');
  assert.match(text(h.render()),/Could not save the key/);
  assert.match(text(h.render()),/Key not configured/);
  submit(h.render(),'Provider settings');await h.flush();
  assert.equal(JSON.stringify(h.requests[1]).includes('fixture-unsaved-secret'),false);
  assert.equal('rapidApiKey' in h.requests[1],false);
});

test('a blank input keeps the saved key and removal requires the explicit confirmation action',async()=>{
  const h=await loaded({configured:true});
  submit(h.render(),'RapidAPI key settings');await h.flush();
  assert.equal(h.requests.length,0);
  assert.match(text(h.render()),/saved RapidAPI key has been kept/);
  button(h.render(),'Remove saved key').props.onClick();
  assert.equal(h.requests.length,0);
  button(h.render(),'Cancel').props.onClick();
  assert.equal(h.requests.length,0);
  button(h.render(),'Remove saved key').props.onClick();
  button(h.render(),'Remove key').props.onClick();await h.flush();
  assert.deepEqual(h.requests[0],{action:'saveRapidApiKey',rapidApiKey:'',clearRapidApiKey:true});
  assert.match(text(h.render()),/Key not configured/);
  assert.match(text(h.render()),/Saved RapidAPI key removed/);
});
