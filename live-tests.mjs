import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {collectLive,liveRound,liveReceipt} from './src/live.mjs';
const sql=new DatabaseSync(':memory:');
let failCommit=false;
const DB={prepare(query){return {query,args:[],bind(...args){this.args=args;return this;},async first(){return sql.prepare(this.query).get(...this.args);},async all(){return {results:sql.prepare(this.query).all(...this.args)};},async run(){const result=sql.prepare(this.query).run(...this.args);return {meta:{changes:Number(result.changes),rows_written:Number(result.changes)}};}};},async batch(statements){
  sql.exec('BEGIN');
  try{const results=[];for(const statement of statements){
    if(failCommit&&statement.query.startsWith('UPDATE live_control SET state')){failCommit=false;throw new Error('simulated failed commit');}
    const before=sql.prepare('SELECT total_changes() n').get().n;
    const result=sql.prepare(statement.query).run(...statement.args);
    results.push({meta:{changes:Number(result.changes),rows_written:sql.prepare('SELECT total_changes() n').get().n-before}});
  }sql.exec('COMMIT');return results;}catch(error){sql.exec('ROLLBACK');throw error;}
}};
const source='GABT7EMPGNCQSZM22DIYC4FNKHUVJTXITUF6Y5HNIWPU4GA7BHT4GC5G';
const at=new Date().toISOString();
const op=(id,amount,hash='h')=>({type:'create_claimable_balance',source_account:source,asset:'native',transaction_successful:true,paging_token:String(id),id:String(id),transaction_hash:hash,amount,created_at:at,claimants:[{destination:'A'}]});
const seed=Array.from({length:200},(_,i)=>i===0?op(201,'0.1'):{type:'payment',paging_token:String(201-i),created_at:at});
let calls=0;
globalThis.fetch=async url=>{calls++;const u=new URL(url);let records=[];
  if(u.searchParams.get('order')==='desc')records=u.searchParams.has('cursor')?[op(1,'0.2')]:seed;
  else if(u.searchParams.get('cursor')==='201')records=[op(202,'0.4','second')];
  return {ok:true,json:async()=>({_embedded:{records}})};
};
await collectLive({DB});
assert.equal(sql.prepare('SELECT units FROM live_receipts WHERE hash=?').get('h').units,3000000,'split-page lockups aggregate exactly');
const state=()=>JSON.parse(sql.prepare('SELECT state FROM live_control').get().state);
assert.equal(state().cursor,'201');assert.equal(state().backfill,null);
failCommit=true;await collectLive({DB});
assert.equal(state().cursor,'201','failure cannot skip a page');
assert.equal(sql.prepare('SELECT COUNT(*) n FROM live_receipt_ops').get().n,2,'batch rollback includes trigger');
await collectLive({DB});assert.equal(state().cursor,'202');
let snapshot=JSON.parse(sql.prepare('SELECT snapshot FROM live_control').get().snapshot);
assert.equal(snapshot.events.length,2);assert.equal(snapshot.events[0].migrationNumber,null,'receipt does not imply round');
// Replay a committed page: no duplicate event or Pi.
sql.prepare('UPDATE live_control SET state=?').run(JSON.stringify({...state(),cursor:'201'}));
await collectLive({DB});assert.equal(sql.prepare('SELECT COUNT(*) n FROM live_receipt_ops').get().n,3);
assert.equal(sql.prepare('SELECT units FROM live_receipts WHERE hash=?').get('second').units,4000000);
const before=calls;sql.prepare('UPDATE live_control SET lease_until=?').run(Date.now()+60000);
await collectLive({DB});assert.equal(calls,before,'overlapping invocation does not collect');
sql.prepare('UPDATE live_control SET lease_until=0,state=?').run(JSON.stringify({...state(),cursor:'201',writes:100}));
await collectLive({DB,LIVE_DAILY_WRITE_BUDGET:'1'});
assert.equal(state().cursor,'201','quota does not advance cursor');
snapshot=JSON.parse(sql.prepare('SELECT snapshot FROM live_control').get().snapshot);assert.match(snapshot.error,/budget/);
assert.equal(liveRound({policyVersion:29,genesis:true,events:[{hash:'first'},{hash:'second'}]},'second'),2);
assert.equal(liveRound({policyVersion:29,genesis:true,ambiguous:true,events:[{hash:'second'}]},'second'),null);
assert.equal(liveReceipt({...op(9,'1'),claimants:[{destination:'A'},{destination:'B'}]}),null);
sql.close();console.log('PASS live: split pages, exact sums, rollback, restart, duplicate prevention, lease, quota, pending and verified evidence');
