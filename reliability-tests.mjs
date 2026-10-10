import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {meteredDatabase,adaptiveController,pendingReason,adjustAudit,auditTotals,auditStep} from './src/reliability.mjs';
import {collectFocus,focusSchema} from './src/focus.mjs';
const sql=new DatabaseSync(':memory:');
let failBatch=false;
function result(query,args){const statement=sql.prepare(query);const results=statement.all(...args);const write=/^\s*(INSERT|UPDATE|DELETE)/i.test(query);const changes=write?Number(sql.prepare('SELECT changes() n').get().n):0;return {results,meta:{changes,rows_written:changes*(/INSERT INTO focus_(events|wallets)/.test(query)?3:1),rows_read:results.length}};}
const DB={prepare(query){return {query,args:[],bind(...args){this.args=args;return this;},async all(){return result(query,this.args)},async first(){return result(query,this.args).results[0]||null},async run(){return result(query,this.args)}}},async batch(statements){sql.exec('BEGIN');try{const out=statements.map(s=>result(s.query,s.args));if(failBatch){failBatch=false;throw Error('rollback test');}sql.exec('COMMIT');return out;}catch(e){sql.exec('ROLLBACK');throw e;}}};
const meter=meteredDatabase(DB);await meter.batch([meter.prepare('CREATE TABLE example(id INTEGER PRIMARY KEY,value TEXT)')]);await meter.prepare('INSERT INTO example VALUES(1,?)').bind('a').run();assert.equal(meter.usage.reportedWrites,1);assert.equal(meter.usage.estimatedWrites,0);
await meter.prepare('UPDATE example SET value=? RETURNING value').bind('b').first();assert.equal(meter.usage.reportedWrites,2,'first() preserves D1 metadata via all()');
failBatch=true;await assert.rejects(meter.batch([meter.prepare("UPDATE example SET value='c'")]));assert.equal(meter.usage.reportedWrites,2,'rolled back batches do not count as successful writes');assert.equal(sql.prepare('SELECT value FROM example').get().value,'b');
const fallback=meteredDatabase({prepare(){return {async run(){return {meta:{changes:1}}}}}});await fallback.prepare('UPDATE sample SET value=1').run();assert.equal(fallback.usage.reportedWrites,0);assert.equal(fallback.usage.estimatedWrites,1);
let api=await adaptiveController(DB);assert.equal(api.level,4);api.bad(Object.assign(Error('429'),{status:429,retryAfterMs:600000}));await api.persist();let other=await adaptiveController(DB);assert.equal(other.level,2);assert.ok(other.paused,'cooldown shared between collectors');
// A stale success must not overwrite a more recent failure.
const stale=other;sql.prepare("UPDATE collector_api_control SET state=json_set(state,'$.pauseUntil',0)").run();api=await adaptiveController(DB);api.bad(Error('503'));await api.persist();stale.good();await stale.persist();assert.equal((await adaptiveController(DB)).level,1);
sql.prepare("UPDATE collector_api_control SET state=json_set(state,'$.pauseUntil',0)").run();api=await adaptiveController(DB);for(let i=0;i<30;i++)api.good();await api.persist();assert.equal((await adaptiveController(DB)).level,2,'gradual recovery after 30 successes');
for(const statement of focusSchema)sql.exec(statement);
const insert=(address,hash,round,units)=>{sql.prepare('INSERT INTO focus_events VALUES(?,?,?,?,?,?)').run(address,hash,'2026-02-01',units,'[]',round);sql.prepare('INSERT INTO focus_wallets VALUES(?,?,?,?)').run(address,'{}',round==null?1:0,'2026-02-01');};
insert('A','a',1,'10');insert('C','c',2,'20');let state={counts:{first:1,second:1,pending:0},volumeUnits:{first:'10',second:'20'}};state.audit=await auditStep(DB,state,Date.now(),1);assert.equal(state.audit.cursor,'A');
state.audit=adjustAudit(state.audit,'A',auditTotals([{round:1,units:'10'}]),auditTotals([{round:1,units:'15'}]));sql.prepare("UPDATE focus_events SET units='15' WHERE address='A'").run();state.volumeUnits.first='15';
insert('0','new',1,'5');state.audit=adjustAudit(state.audit,'0',auditTotals([]),auditTotals([{round:1,units:'5'}]));state.counts.first++;state.volumeUnits.first='20';
state.audit=await auditStep(DB,state,Date.now(),1);state.audit=await auditStep(DB,state,Date.now(),1);assert.equal(state.audit.status,'consistent','audit adjusts already-scanned prefixes while collection continues');
state.counts.second++;state.audit=await auditStep(DB,state,Date.now()+86400001,250);assert.equal(state.audit.status,'mismatch');assert.equal(state.counts.second,2,'audit never silently repairs counters');
assert.equal(pendingReason({ambiguous:true}),'Ambiguous recipient history');assert.match(pendingReason({genesis:false,complete:true,error:'old'}),/Account creation missing/);assert.match(pendingReason({error:'429'}),/API error/);assert.match(pendingReason({}),/first history query/);assert.match(pendingReason({cursor:'5'}),/in progress/);
// Historical evidence resolves a live second migration without re-reading its history.
sql.exec("DELETE FROM focus_events;DELETE FROM focus_wallets;DELETE FROM focus_control;UPDATE collector_api_control SET state='{}',revision=revision+1;CREATE TABLE historical2026_wallets(address TEXT PRIMARY KEY,evidence TEXT)");
const SOURCE='GABT7EMPGNCQSZM22DIYC4FNKHUVJTXITUF6Y5HNIWPU4GA7BHT4GC5G',at=new Date().toISOString();
const receipt={type:'create_claimable_balance',source_account:SOURCE,asset:'native',transaction_successful:true,transaction_hash:'second',paging_token:'100',id:'100',created_at:at,amount:'10',claimants:[{destination:'BENEFICIARY'}]};
sql.prepare('INSERT INTO historical2026_wallets VALUES(?,?)').run('BENEFICIARY',JSON.stringify({policyVersion:29,genesis:true,cursor:'100',events:[{hash:'first',at},{hash:'second',at}]}));
sql.prepare('INSERT INTO focus_control(id,state) VALUES(1,?)').run(JSON.stringify({startedAt:at,cursor:'99',counts:{first:0,second:0,pending:0}}));let beneficiaryCalls=0;
globalThis.fetch=async url=>{const u=new URL(url);if(u.pathname.includes('/BENEFICIARY/'))beneficiaryCalls++;if(u.pathname.endsWith('/operations'))return {ok:true,json:async()=>({_embedded:{records:[receipt]}})};return {ok:true,json:async()=>({balances:[{asset_type:'native',balance:'100'}]})};};
await collectFocus({DB});const snapshot=JSON.parse(sql.prepare('SELECT snapshot FROM focus_control').get().snapshot);assert.equal(snapshot.counts.second,1);assert.equal(snapshot.volumes.secondPi,'10.0000000');assert.equal(beneficiaryCalls,0);assert.ok(snapshot.diagnostics.storage.reportedWrites>0);assert.equal(snapshot.diagnostics.storage.estimatedWrites,2,'only final persistence remains reserved');assert.equal(snapshot.diagnostics.audit.status,'consistent');
console.log('PASS v47: measured D1 writes, fallback/reservation, rollback, shared cooldown, adaptive recovery, incremental audit with concurrent changes, mismatch alerts, pending reasons and reverse evidence reuse');
sql.close();
