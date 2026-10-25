import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {Script} from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

const require = createRequire(import.meta.url);
const account = {id:'admin',name:'Admin',email:'admin@example.test',userType:'admin',createdAt:'2026-10-01',lastSeenAt:'2026-10-25'};
const person = {...account,id:'person',name:null,email:'person@example.test',userType:'user',collectionCount:1,pageCount:1};
const summary = {users:1,admins:1,collections:1,pages:1,memberships:1};

/** Drive the component's handlers, then render before passive effects, as React does.
 * The real JSX renderer catches invalid rows rather than testing source strings. */
function harness() {
  const slots=[],pending=[];
  let cursor=0;
  const hooks={...React,
    useState(initial){const index=cursor++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;return [slots[index],value=>{slots[index]=typeof value==='function'?value(slots[index]):value;}];},
    useRef(initial){const index=cursor++;if(!(index in slots))slots[index]={current:initial};return slots[index];},
    useEffect(effect,deps){const index=cursor++;const previous=slots[index];if(!previous||deps.some((value,i)=>!Object.is(value,previous.deps[i]))){slots[index]={deps,cleanup:previous?.cleanup};pending.push(()=>{previous?.cleanup?.();slots[index].cleanup=effect();});}},
  };
  const source=readFileSync(new URL('../components/admin-dashboard.tsx',import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const exports={};
  const context={exports,URLSearchParams,AbortController,console,
    require(name){if(name==='react')return hooks;if(name==='@/components/auth/sign-out-button')return {default:props=>React.createElement('button',props,props.children)};if(name==='@/components/admin-record-actions')return {default:()=>null};return require(name);},
    fetch:async url=>{const params=new URL(url,'https://desk.test').searchParams;const section=params.get('section');
      const items=section==='users'?[person]:section==='collections'?[{id:'collection',name:'Saved collection',ownerId:person.id,ownerName:null,ownerEmail:person.email,createdAt:'2026-10-01',pageCount:1}]:[];
      return Response.json({section,items,total:items.length,offset:0,limit:25,hasMore:false,summary});},
  };
  new Script(code,{filename:'admin-dashboard.js'}).runInNewContext(context);
  const Component=exports.default;
  const render=()=>{cursor=0;return Component({account});};
  const flush=async()=>{while(pending.length)pending.shift()();await new Promise(resolve=>setImmediate(resolve));};
  return {render,flush};
}

function find(node,predicate){
  if(!node||typeof node!=='object')return null;
  if(Array.isArray(node)){for(const child of node){const match=find(child,predicate);if(match)return match;}return null;}
  if(predicate(node))return node;
  return find(node.props?.children,predicate);
}
function click(tree,label){const button=find(tree,node=>node.type==='button'&&node.props['aria-label']===label);assert.ok(button,'Button exists: '+label);button.props.onClick();}

test('switching People to Pages never renders an unnamed person as a page',async()=>{
  const h=harness();h.render();await h.flush();const people=h.render();
  assert.match(renderToStaticMarkup(people),/person@example.test/);
  click(people,'Browse all pages');
  const beforeEffect=renderToStaticMarkup(h.render());
  assert.match(beforeEffect,/Loading pages/);
  assert.doesNotMatch(beforeEffect,/person@example.test/);
  await h.flush();assert.match(renderToStaticMarkup(h.render()),/No pages here yet/);
});

test('search changes hide the previous results before the request effect starts',async()=>{
  const h=harness();h.render();await h.flush();const people=h.render();
  const input=find(people,node=>node.type==='input'&&node.props['aria-label']==='Search people');
  input.props.onChange({target:{value:'another person'}});
  const edited=h.render();const form=find(edited,node=>node.type==='form');form.props.onSubmit({preventDefault(){}});
  const beforeEffect=renderToStaticMarkup(h.render());
  assert.match(beforeEffect,/Loading people/);
  assert.doesNotMatch(beforeEffect,/person@example.test/);
});
