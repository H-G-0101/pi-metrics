import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {collectFocus,focusVerificationQueue} from './src/focus.mjs';
const sql=new DatabaseSync(':memory:');let fail=false;
const DB={prepare(query){return {query,args:[],bind(...args){this.args=args;return this;},async first(){return sql.prepare(query).get(...this.args);},async all(){return {results:sql.prepare(query).all(...this.args)};},async run(){const r=sql.prepare(query).run(...this.args);return {meta:{changes:Number(r.changes),rows_written:Number(r.changes)}};}};},async batch(statements){sql.exec('BEGIN');try{const out=[];for(const s of statements){if(fail&&s.query.startsWith('UPDATE focus_control SET state')){fail=false;throw new Error('Simulated atomic failure');}if(s.query.startsWith('SELECT'))out.push({results:sql.prepare(s.query).all(...s.args),meta:{changes:0}});else{const r=sql.prepare(s.query).run(...s.args);out.push({results:[],meta:{changes:Number(r.changes)}});}}sql.exec('COMMIT');return out;}catch(e){sql.exec('ROLLBACK');throw e;}}};
const SOURCE='GABT7EMPGNCQSZM22DIYC4FNKHUVJTXITUF6Y5HNIWPU4GA7BHT4GC5G',at=new Date().toISOString();
const op=(id,address,hash,amount='1')=>({type:'create_claimable_balance',source_account:SOURCE,asset:'native',transaction_successful:true,transaction_hash:hash,paging_token:String(id),id:String(id),created_at:at,amount,claimants:[{destination:address}]});
const birth=(id,address,hash)=>({...op(id,address,hash),type:'create_account',account:address});
const old=op(100,'OLD','old');let chain=[old],history={};const calls=[];let balanceFetches=0,balanceFail=false;
globalThis.fetch=async url=>{const u=new URL(url);if(!u.pathname.endsWith('/operations')){balanceFetches++;return balanceFail?{ok:false,status:503}:{ok:true,json:async()=>({balances:[{asset_type:'native',balance:'1234567.1234567'}]})};}const address=u.pathname.split('/')[2],cursor=BigInt(u.searchParams.get('cursor')||0),order=u.searchParams.get('order'),limit=Number(u.searchParams.get('limit'));calls.push({address,cursor:String(cursor),order,limit});const records=(address===SOURCE?chain:history[address]||[]).filter(r=>order==='desc'||BigInt(r.paging_token)>cursor).sort((a,b)=>Number(BigInt(a.paging_token)-BigInt(b.paging_token))*(order==='desc'?-1:1)).slice(0,limit);return {ok:true,json:async()=>({_embedded:{records}})};};
const state=()=>JSON.parse(sql.prepare('SELECT state FROM focus_control').get().state),snapshot=()=>JSON.parse(sql.prepare('SELECT snapshot FROM focus_control').get().snapshot);
await collectFocus({DB});assert.equal(state().cursor,'100');assert.deepEqual(state().counts,{first:0,second:0,pending:0});assert.equal(sql.prepare('SELECT COUNT(*) n FROM focus_events').get().n,0,'old migrations are not imported into the new epoch');
chain.push(birth(101,'A','A1'),op(102,'A','A1','0.1'),op(103,'A','A1','0.2'));await collectFocus({DB});assert.equal(state().counts.first,1);assert.equal(state().counts.pending,0);assert.equal(sql.prepare("SELECT units FROM focus_events WHERE address='A'").get().units,'3000000');
chain.push(op(104,'B','B2','20'));history.B=[birth(1,'B','B1'),op(2,'B','B1'),chain.at(-1)];await collectFocus({DB});assert.equal(state().counts.second,1,'targeted history confirms second');
history.A=chain.filter(r=>r.account==='A'||r.claimants?.[0]?.destination==='A');chain.push(op(105,'A','A2','10'));history.A.push(chain.at(-1));await collectFocus({DB});assert.deepEqual(state().counts,{first:1,second:2,pending:0},'same wallet can be in both distinct confirmed counters');
sql.prepare('UPDATE focus_control SET state=?').run(JSON.stringify({...state(),cursor:'100'}));await collectFocus({DB});assert.deepEqual(state().counts,{first:1,second:2,pending:0},'replay cannot duplicate counts');assert.equal(sql.prepare('SELECT COUNT(*) n FROM focus_events').get().n,3);
chain.push(birth(106,'C','C1'),op(107,'C','C1','3'));fail=true;await collectFocus({DB});assert.equal(state().cursor,'105');assert.equal(state().counts.first,1);assert.equal(sql.prepare("SELECT COUNT(*) n FROM focus_events WHERE address='C'").get().n,0,'failure rolls back events, evidence, counters and cursor');
await collectFocus({DB});assert.equal(state().counts.first,2);
const savedACursor=JSON.parse(sql.prepare("SELECT evidence FROM focus_wallets WHERE address='A'").get().evidence).cursor;const callStart=calls.length;
chain.push(op(108,'A','A3','5'));history.A.push(chain.at(-1));await collectFocus({DB});assert.equal(calls.slice(callStart).find(c=>c.address==='A').cursor,savedACursor,'confirmed history resumes from its saved cursor');assert.equal(state().counts.second,2,'third migration cannot inflate second');assert.equal(state().counts.pending,0);
chain.push({...op(109,'X','ambiguous'),claimants:[{destination:'X'},{destination:'Y'}]});await collectFocus({DB});assert.equal(state().counts.pending,0,'ambiguous recipients are excluded');
chain.push(op(110,'U','unknown'));history.U=[op(1,'U','earlier'),chain.at(-1)];await collectFocus({DB});assert.equal(state().counts.pending,1,'missing account genesis never implies a migration number');
const prev=snapshot();prev.ranking.updatedAt='2000-01-01';sql.prepare('UPDATE focus_control SET snapshot=?').run(JSON.stringify(prev));await collectFocus({DB});assert.equal(snapshot().ranking.rows[0].address,'B');assert.equal(snapshot().ranking.rows.find(r=>r.address==='A').amountPi,'15.3000000');
assert.equal(snapshot().sourceAccount.balance,'1234567.1234567');assert.equal(balanceFetches,1,'source balance is cached across collector runs');
assert.equal(snapshot().lastMigrationHash,'unknown','pending receipts also count as observed migrations');
chain.push({...op(111,'A','payment'),type:'payment'});await collectFocus({DB});assert.equal(snapshot().lastMigrationHash,'unknown','payments do not replace the last migration');
balanceFail=true;
assert.equal(calls.filter(c=>c.address===SOURCE&&c.order==='desc').length,1,'only one latest-operation anchor; no source backfill');assert.equal(calls.find(c=>c.address===SOURCE&&c.order==='desc').limit,1);
assert.deepEqual(snapshot().volumes,{firstPi:'3.3000000',secondPi:'30.0000000'},'combined lockups, replay, rollback, pending and third events preserve exact totals');
const RealDate=Date,clock=Date.now()+8*86400000;globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}};
await collectFocus({DB});assert.equal(snapshot().ranking.rows.length,0,'seven-day ranking expires old receipts');assert.equal(state().counts.first,2);assert.equal(state().counts.second,2,'cumulative counters do not expire');assert.equal(sql.prepare('SELECT COUNT(*) n FROM focus_events').get().n,6,'stored receipts remain');globalThis.Date=RealDate;assert.deepEqual(snapshot().volumes,{firstPi:'3.3000000',secondPi:'30.0000000'},'cumulative Pi never expires with the ranking');
const before=calls.length;sql.prepare('UPDATE focus_control SET lease_until=?').run(Date.now()+60000);await collectFocus({DB});assert.equal(calls.length,before,'overlapping collector never reads blockchain');
assert.equal(snapshot().sourceAccount.balance,'1234567.1234567','failed balance update preserves last known balance');assert.match(snapshot().sourceAccount.error,/503/);assert.equal(snapshot().error,null,'balance failure does not stop migration collection');
// A failed activation must never import the same legacy usage repeatedly.
sql.exec('DELETE FROM focus_control; DELETE FROM focus_events; DELETE FROM focus_wallets; CREATE TABLE live_control(id INTEGER PRIMARY KEY,state TEXT)');
sql.prepare('INSERT INTO live_control VALUES(1,?)').run(JSON.stringify({day:new Date().toISOString().slice(0,10),writes:90000}));
await collectFocus({DB,FOCUS_DAILY_WRITE_BUDGET:85000});const consumed=state().writes;assert.equal(state().startedAt,undefined);assert.match(snapshot().error,/budget/);
await collectFocus({DB,FOCUS_DAILY_WRITE_BUDGET:85000});assert.equal(state().writes,consumed+8,'legacy quota is carried only once, even after failed activation');
// Queue priority, fairness, retry gates and unused-slot reuse on real SQLite.
sql.exec('DELETE FROM focus_wallets');
const insert=sql.prepare('INSERT INTO focus_wallets VALUES(?,?,?,?)');
for(const a of ['G1','G2','G3','G4','T1','T2','T3','T4'])insert.run(a,'{}',1,'2000-01-01');
insert.run('FUTURE','{}',1,'2999-01-01');insert.run('DONE','{}',0,'2000-01-01');
const ranked={rows:['T1','T2','T3','T4','FUTURE','DONE'].map(address=>({address}))};
assert.deepEqual(await focusVerificationQueue(DB,ranked,at),['G1','T1','T2','T3']);
sql.prepare("UPDATE focus_wallets SET retry_at='2999-01-01' WHERE address IN ('G1','T1','T2','T3')").run();
assert.deepEqual(await focusVerificationQueue(DB,ranked,at),['G2','T4','G3','G4']);
assert.deepEqual(await focusVerificationQueue(DB,null,at),['G2','G3','G4','T4']);
// One transaction mixes a new account and a second migration for another account.
sql.exec('DELETE FROM focus_control; DELETE FROM focus_events; DELETE FROM focus_wallets; DROP TABLE live_control');
chain=[old];await collectFocus({DB});
chain.push(birth(101,'NEW','mixed'),op(102,'NEW','mixed'),op(103,'EXISTING','mixed','2'),op(104,'EXISTING','mixed','3'));
history.EXISTING=[birth(1,'EXISTING','first'),op(2,'EXISTING','first'),...chain.slice(-2)];
await collectFocus({DB});
assert.equal(sql.prepare("SELECT round FROM focus_events WHERE address='NEW'").get().round,1);
assert.equal(sql.prepare("SELECT round FROM focus_events WHERE address='EXISTING'").get().round,2);
assert.equal(sql.prepare("SELECT units FROM focus_events WHERE address='EXISTING'").get().units,'50000000');
assert.deepEqual(state().counts,{first:1,second:1,pending:0});
console.log('PASS v38: Top 20 priority, general queue fairness, retry gates, cached cursor reuse and mixed transaction recipients');
// Paid throughput and API backoff preserve completed batches and failed cursors.
sql.exec('DELETE FROM focus_control; DELETE FROM focus_events; DELETE FROM focus_wallets');
chain=[old];await collectFocus({DB});
for(let i=0;i<12;i++){
 const address='PAID'+i;
 const receipt=op(200+i,address,'new'+i);
 chain.push(receipt);history[address]=[birth(1,address,'old'+i),op(2,address,'old'+i),receipt];
}
const underlyingFetch=globalThis.fetch;let active=0,peak=0,requests=0,apiFail=false;
globalThis.fetch=async url=>{
 const u=new URL(url),address=u.pathname.split('/')[2];
 if(address.startsWith('PAID')&&u.pathname.endsWith('/operations')){
  active++;peak=Math.max(peak,active);requests++;
  await new Promise(resolve=>setTimeout(resolve,2));
  active--;
  if(apiFail)return {ok:false,status:429};
 }
 return underlyingFetch(url);
};
await collectFocus({DB});
assert.equal(requests,12);assert.equal(peak,4);assert.equal(state().counts.second,12);
chain.push(op(300,'PAIDFAIL','failure'));apiFail=true;
await collectFocus({DB});assert.ok(state().historyPauseUntil>Date.now());
assert.equal(JSON.parse(sql.prepare("SELECT evidence FROM focus_wallets WHERE address='PAIDFAIL'").get().evidence).cursor,'');
const pausedRequests=requests;await collectFocus({DB});assert.equal(requests,pausedRequests,'backoff prevents historical API calls');
assert.equal(state().counts.second,12,'API error preserves successful classifications');
globalThis.fetch=underlyingFetch;
console.log('PASS v39: 12 histories per run, maximum four simultaneous requests, 429 cooldown and preserved progress');
assert.deepEqual(snapshot().volumes,{firstPi:'0.0000000',secondPi:'12.0000000'});
const upgrade=state();delete upgrade.volumeUnits;
sql.prepare('UPDATE focus_control SET state=?').run(JSON.stringify(upgrade));
await collectFocus({DB});
assert.deepEqual(snapshot().volumes,{firstPi:'0.0000000',secondPi:'12.0000000'},'upgrade reconstructs already confirmed totals without resetting the epoch');
assert.equal(state().startedAt,upgrade.startedAt);
console.log('PASS v40: exact cumulative Pi, one-time upgrade, no expiry or double counting');
sql.close();console.log('PASS focus: activation boundary, exact combined lockups, distinct counters, targeted history, replay, atomic rollback, later and ambiguous cases, ranking expiry, preserved history and lease');
