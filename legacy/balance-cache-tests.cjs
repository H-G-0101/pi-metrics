const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/worker.js','utf8').replace('export default {','globalThis.worker = {');
let now=Date.now(),upstream=0;const entries=new Map(),pending=[];
const context={console,URL,Request,Response,AbortSignal,crypto,atob,btoa,TextEncoder,TextDecoder,fetch:async()=>{upstream++;return new Response(JSON.stringify({balances:[{asset_type:'native',balance:'123.5'}]}));},caches:{default:{async match(key){const row=entries.get(key.url);return row&&row.expires>now?row.response.clone():undefined;},async put(key,response){entries.set(key.url,{response:response.clone(),expires:now+1800000});}}}};
vm.createContext(context);vm.runInContext(source,context);
const address='G'+'A'.repeat(55),request=()=>new Request('https://test.example/wallet-balances?addresses='+address);
const ctx={waitUntil(promise){pending.push(promise);}};
(async()=>{
 const first=await (await context.worker.fetch(request(),{},ctx)).json();await Promise.all(pending);
 assert.equal(first.balances[address],123.5);assert.ok(first.balanceUpdatedAt[address]);assert.equal(upstream,1);
 const second=await (await context.worker.fetch(request(),{},ctx)).json();assert.equal(upstream,1,'another visitor reuses the server balance cache');assert.equal(second.balanceUpdatedAt[address],first.balanceUpdatedAt[address],'cache hit keeps original observation time');
 now+=1800001;await context.worker.fetch(request(),{},ctx);await Promise.all(pending);assert.equal(upstream,2,'expired cache fetches a new balance');
 console.log('PASS balance: cross-request cache, original freshness timestamp and 30-minute expiration');
})().catch(error=>{console.error(error);process.exitCode=1;});
