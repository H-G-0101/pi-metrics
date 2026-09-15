const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-audit-'));
const file=path.join(dir,'checkpoint.json');
let source=fs.readFileSync(path.join(__dirname,'migracao-stats.mjs'),'utf8').replace(/^#!.*\n/,'').replace(/import \{[\s\S]*?\} from 'node:fs';/,'');
source=source.slice(0,source.lastIndexOf('(async () => {'));
source+='\n globalThis.api={verifyTopWallets,ledgerOperations,classifyRecentEvents,record,addRecentOperation,saveCheckpoint,loadState,restoreFromD1,seedD1,syncD1Wallets,buildReport,getState:()=>state,setState:x=>state=x,setLoaded:x=>checkpointLoaded=x};';
const calls=[];
let respond=()=>({});
const ctx={...fs,console,URL,AbortSignal,setTimeout,clearTimeout,process:{env:{CHECKPOINT_FILE:file,PUSH_URL:'https://test/stats',PUSH_TOKEN:'test',INFER_SECOND:'0'},on:()=>{}},fetch:async(url,options)=>{calls.push({url,body:options?.body?JSON.parse(options.body):null});return {ok:true,json:async()=>respond(url,options)};}};
vm.createContext(ctx);vm.runInContext(source,ctx);
const api=ctx.api;
(async()=>{
 const state=api.getState();
 state.byDest.A={firstTx:'old',firstAt:'2022-01-01',eventCount:1};state.lastSeenAt='2023-01-01';state.recentEvents.x={address:'A',transactionHash:'third',createdAt:'2026-09-12',amountPi:10};
 assert.equal(api.classifyRecentEvents()[0].migrationNumber,null,'gap must remain pending');
 state.byDest.A.secondTx='third';assert.equal(api.classifyRecentEvents()[0].migrationNumber,2,'indexed second hash');
 const op={type:'create_claimable_balance',source_account:state.wallet,claimants:[{destination:'B'}],transaction_hash:'first',created_at:'2022-01-01',amount:'10'};
 api.record(op);api.record(op);assert.equal(state.byDest.B.eventCount,1);
 api.record({...op,transaction_hash:'second'});assert.equal(state.byDest.B.eventCount,2);
 api.saveCheckpoint();const saved=JSON.parse(fs.readFileSync(file));assert.ok(saved.generation);
 assert.equal(api.loadState().byDest.B.eventCount,2,'checkpoint generation restore');
 // Com INFER_SECOND, um hash desconhecido vira 2ª migração; o índice tem prioridade.
 {
  const f2=path.join(dir,'infer.json');
  const c2={...fs,console,URL,AbortSignal,setTimeout,clearTimeout,process:{env:{CHECKPOINT_FILE:f2,PUSH_URL:'https://test/stats',PUSH_TOKEN:'test'},on:()=>{}},fetch:async()=>({ok:true,json:async()=>({})})};
  vm.createContext(c2);vm.runInContext(source,c2);
  const s2=c2.api.getState();
  s2.recentEvents.x={address:'A',transactionHash:'unknown',createdAt:'2026-09-12',amountPi:10};
  let row=c2.api.classifyRecentEvents()[0];
 assert.equal(row.migrationNumber,null,'unknown hash stays pending by default');
  assert.equal(row.classifiedBy,null);
  s2.accountBirth.A={tx:'older',at:'2022-01-01',validated:true};
  assert.equal(c2.api.classifyRecentEvents()[0].migrationNumber,null,'account age cannot prove a second migration');
  s2.recentCreatedAccountKeys['unknown:A']=true;
  row=c2.api.classifyRecentEvents()[0];
  assert.equal(row.migrationNumber,1,'create_account wins over inference');
  assert.equal(row.classifiedBy,'create_account');
  delete s2.recentCreatedAccountKeys['unknown:A'];
  s2.byDest.A={firstTx:'unknown',firstAt:'2022-01-01',eventCount:1};
  row=c2.api.classifyRecentEvents()[0];
  assert.equal(row.migrationNumber,1,'index wins over inference');
  assert.equal(row.classifiedBy,'index');
  s2.byDest.A.secondTx='second';s2.byDest.A.secondAt='2022-01-02';s2.byDest.A.eventCount=2;
  const totals=c2.api.buildReport({complete:false});
  s2.recentEvents={};
  assert.equal(c2.api.buildReport({complete:false}).receivedSecondMigration,totals.receivedSecondMigration,'recent expiry preserves lifetime');
 }
 // A newer remote cursor must win over an existing local checkpoint.
 api.setLoaded(true);state.cursor='10';
 const meta={formatVersion:26,cursor:'20',pages:2,scannedRecords:200,claimableBalances:2,walletCount:1,wallet:state.wallet};
 respond=url=>url.includes('metaOnly')?{protocol:26,meta}:{meta,hasMore:false,wallets:[{address:'C',firstTx:'c1',firstAt:'2022-01-01',eventCount:1}]};
 await api.restoreFromD1();assert.equal(api.getState().cursor,'20');assert.equal(api.getState().byDest.C.firstTx,'c1');assert.equal(api.getState().byDest.A,undefined);
 calls.length=0;respond=()=>({});
 api.getState().cursor='25';api.setLoaded(true);
 respond=url=>({protocol:26,meta});
 await api.restoreFromD1();
 assert.equal(api.getState().cursor,'25','local cursor cannot rewind without its index');
 assert.equal(api.getState().d1Ready,false,'newer local snapshot must seed');
 respond=()=>({rowsWritten:7});
 calls.length=0;
 const spent=api.getState().d1Budget.rows;
 await api.syncD1Wallets(Array.from({length:100},(_,i)=>({address:String(i)})),{cursor:'21'});
 assert.equal(calls.length,1,'one atomic request per page');assert.equal(calls[0].body.wallets.length,100);assert.equal(calls[0].body.meta.cursor,'21');
 assert.equal(api.getState().d1Budget.rows-spent,7,'use actual D1 writes');
 api.getState().d1Ready=false;calls.length=0;await api.seedD1();
 assert.equal(calls[0].body.meta.rebuilding,true);assert.equal(calls.at(-1).body.meta.walletCount,1);assert.equal(api.getState().d1Ready,true);
 // A matching frozen seed resumes its committed offset, never starts at zero.
 api.setLoaded(true);api.getState().d1SeedId='same-snapshot';api.getState().d1SeedOffset=32000;
 respond=()=>({protocol:26,meta:{...meta,rebuilding:true,seedId:'same-snapshot'}});
 await api.restoreFromD1();assert.equal(api.getState().d1SeedOffset,32000);
 respond=()=>({protocol:26,meta:{...meta,rebuilding:true,seedId:'different-snapshot'}});
 await api.restoreFromD1();assert.equal(api.getState().d1SeedOffset,0,'different snapshot restarts safely');
 // Partial restoration must leave the existing in-memory index untouched.
 api.setLoaded(false);const before=api.getState().byDest;
 respond=url=>url.includes('metaOnly')?{protocol:26,meta:{...meta,cursor:'30'}}:{meta:{...meta,cursor:'31'},wallets:[]};
 await assert.rejects(api.restoreFromD1(),/changed during restore/);assert.equal(api.getState().byDest,before);
 // Execute Worker against a fake KV: corrections accepted, old schemas rejected.
 const worker=fs.readFileSync(path.join(__dirname,'worker.js'),'utf8').replace('export default {','globalThis.worker = {');
 const wc={Response,Request,URL,Uint8Array,atob,console};vm.createContext(wc);vm.runInContext(worker,wc);
 let value=JSON.stringify({schemaVersion:15,generatedAt:'2026-09-13T10:00:00Z',firstMigrationsDetected:1000,receivedSecondMigration:100});
 const env={STATS_TOKEN:'test',STATS:{get:async()=>value,put:async(k,v)=>value=v}};
 const post=body=>wc.worker.fetch(new Request('https://test/stats',{method:'POST',headers:{authorization:'Bearer test'},body:JSON.stringify(body)}),env);
 assert.equal((await post({schemaVersion:15,generatedAt:'2026-09-13T11:00:00Z',firstMigrationsDetected:1000,receivedSecondMigration:80})).status,200);
 assert.equal(JSON.parse(value).receivedSecondMigration,80);
 assert.equal((await post({schemaVersion:13})).status,409);
 assert.equal((await post({schemaVersion:15,generatedAt:'2026-09-13T09:00:00Z'})).status,409);
 assert.equal((await post({schemaVersion:15})).status,400);
 // Quota refusal cannot acknowledge rows or final metadata that were never sent.
 for(const initialOffset of [0,1]){
   const qc={...fs,console,URL,AbortSignal,setTimeout,clearTimeout,process:{env:{CHECKPOINT_FILE:path.join(dir,'quota'+initialOffset+'.json'),PUSH_URL:'https://test/stats',PUSH_TOKEN:'test',D1_DAILY_ROW_BUDGET:'1'},on:()=>{}},fetch:async()=>({ok:true,json:async()=>({rowsWritten:1})})};
   vm.createContext(qc);vm.runInContext(source,qc);
   const qs=qc.api.getState();qs.byDest.A={firstTx:'a',firstAt:'2022-01-01',eventCount:1};qs.d1SeedOffset=initialOffset;
   if(initialOffset)qs.d1Budget={day:new Date().toISOString().slice(0,10),rows:1};
   assert.equal(await qc.api.seedD1(),false);
   assert.equal(qs.d1SeedOffset,initialOffset,'quota preserves last committed offset');
   assert.equal(qs.d1Ready,false,'quota cannot mark snapshot ready');
 }
 {
  const requests=[];let history=[];
  const hc={...fs,console,URL,AbortSignal,setTimeout,clearTimeout,process:{env:{CHECKPOINT_FILE:path.join(dir,'history.json'),PUSH_URL:'https://test/stats',PUSH_TOKEN:'test',THROTTLE_MS:'0'},on:()=>{}},fetch:async(url,options)=>{
   requests.push({url,body:options?.body?JSON.parse(options.body):null});
   return {ok:true,json:async()=>String(url).includes('/accounts/')?{_embedded:{records:String(url).includes('cursor=')?[]:history}}:String(url).includes('/d1/evidence')?{evidence:null}:{ledgerProtocol:28,rowsWritten:3}};
  }};
  vm.createContext(hc);vm.runInContext(source,hc);const hs=hc.api.getState();const now=new Date().toISOString();
  const base={type:'create_claimable_balance',source_account:hs.wallet,asset:'native',claimants:[{destination:'TARGET',predicate:{unconditional:true}}],amount:'10',created_at:now};
  history=[{type:'create_account',account:'TARGET',paging_token:'1'},...['a','a','b','b','c'].map((hash,i)=>({...base,transaction_hash:hash,id:String(i+2),paging_token:String(i+2)}))];
  hs.recentEvents.x={address:'TARGET',transactionHash:'c',createdAt:now,amountPi:10,balanceCount:1,tranches:[]};
  hs.byDest.TARGET={firstTx:'c',eventCount:1}; // deliberately wrong legacy ordinal
  await hc.api.verifyTopWallets();
  assert.equal(hc.api.classifyRecentEvents()[0].migrationNumber,3,'full wallet history corrects a wrong legacy ordinal');
  assert.equal(hc.api.classifyRecentEvents()[0].evidence.previous.hash,'b');
  assert.equal(hs.walletEvidence.TARGET.events.length,3,'two lockups in one hash remain one migration');
  const committed=requests.find(r=>r.body?.verification);assert.equal(committed.body.operations.length,5);assert.ok(committed.body.verification.evidence.complete);
  await hc.api.verifyTopWallets();assert.ok(requests.some(r=>String(r.url).includes('cursor=6')),'resume at saved history cursor');
  assert.equal(hc.api.ledgerOperations([{...history[1],asset:'USD:issuer'}]).length,0,'ignore nonnative assets');
 }
 console.log('PASS: classification, lifetime, D1 recovery and quota, paginated wallet history, incremental resume, evidence, third migration and native asset filter');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>fs.rmSync(dir,{recursive:true,force:true}));
