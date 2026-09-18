import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {collectHistorical,HISTORICAL_SINCE} from './src/historical.mjs';
import {focusSchema} from './src/focus.mjs';
const sql=new DatabaseSync(':memory:');let fail=false;
const DB={prepare(query){return {query,args:[],bind(...args){this.args=args;return this;},async first(){return sql.prepare(query).get(...this.args);},async all(){return {results:sql.prepare(query).all(...this.args)};},async run(){const r=sql.prepare(query).run(...this.args);return {meta:{changes:Number(r.changes),rows_written:Number(r.changes)}};}};},async batch(statements){sql.exec('BEGIN');try{const out=[];for(const s of statements){if(fail&&s.query.startsWith('UPDATE focus_control SET state')){fail=false;throw new Error('Simulated atomic failure');}if(s.query.startsWith('SELECT'))out.push({results:sql.prepare(s.query).all(...s.args),meta:{changes:0}});else{const r=sql.prepare(s.query).run(...s.args);out.push({results:[],meta:{changes:Number(r.changes)}});}}sql.exec('COMMIT');return out;}catch(e){sql.exec('ROLLBACK');throw e;}}};

for(const q of focusSchema)sql.exec(q);
sql.prepare('UPDATE focus_control SET state=?,snapshot=?').run('{"live":"preserved"}','{"live":"preserved"}');
const SOURCE='GABT7EMPGNCQSZM22DIYC4FNKHUVJTXITUF6Y5HNIWPU4GA7BHT4GC5G';
const dates={1:'2024-01-01T00:00:00Z',2:'2025-01-31T23:59:59Z',3:'2025-02-01T00:00:00Z',4:'2025-02-01T00:00:05Z',5:'2025-02-02T00:00:00Z',6:'2026-09-17T00:00:00Z'};
const op=(id,address,hash,amount='1',created_at=dates[4])=>({type:'create_claimable_balance',source_account:SOURCE,asset:'native',transaction_successful:true,transaction_hash:hash,paging_token:String(id),id:String(id),created_at,amount,claimants:[{destination:address}]});
const birth=(id,address,hash,created_at)=>({...op(id,address,hash,'1',created_at),type:'create_account',account:address});
let chain=[birth(10,'A','oldA',dates[1]),op(11,'A','oldA','100',dates[1]),op(40,'A','newA','2'),op(41,'A','newA','3'),birth(42,'B','mixed',dates[4]),op(43,'B','mixed','10'),op(44,'C','mixed','7'),{...op(60,'X','tail','1',dates[6]),type:'payment'}];
const histories={A:[chain[0],chain[1],chain[2],chain[3]],C:[birth(1,'C','oldC',dates[1]),op(2,'C','oldC','100',dates[1]),chain[6]]};
let calls=[],inject=true,pruned=false;
globalThis.fetch=async url=>{
 const u=new URL(url),p=u.pathname;calls.push(p);
 const ok=data=>({ok:true,json:async()=>data});
 if(p==='/ledgers')return ok({_embedded:{records:[{sequence:6,closed_at:dates[6]}]}});
 if(/^\/ledgers\/\d+$/.test(p)){
  if(pruned)return {ok:false,status:404};
  const n=Number(p.split('/')[2]);return ok({sequence:n,closed_at:dates[n]});
 }
 if(p==='/ledgers/3/operations')return ok({_embedded:{records:[]}});
 if(p==='/ledgers/4/operations')return ok({_embedded:{records:[chain[2]]}});
 if(p.endsWith('/operations')){
  const address=p.split('/')[2],desc=u.searchParams.get('order')==='desc',cursor=BigInt(u.searchParams.get('cursor')||0),limit=Number(u.searchParams.get('limit'));
  if(address===SOURCE&&!desc&&inject){inject=false;chain.push(op(70,'A','third','8',dates[6]));histories.A.push(chain.at(-1));}
  const rows=(address===SOURCE?chain:histories[address]||[]).filter(x=>desc||BigInt(x.paging_token)>cursor).sort((a,b)=>(Number(a.paging_token)-Number(b.paging_token))*(desc?-1:1)).slice(0,limit);
  return ok({_embedded:{records:rows}});
 }
 throw new Error('Unexpected API call '+p);
};
const snapshot=()=>JSON.parse(sql.prepare('SELECT snapshot FROM historical_control').get().snapshot);
const state=()=>JSON.parse(sql.prepare('SELECT state FROM historical_control').get().state);
await collectHistorical({DB});
assert.equal(state().startedAt,HISTORICAL_SINCE);
assert.equal(state().cursor,'60','initial scan stops at saved target');
assert.equal(state().sourceComplete,true);
assert.deepEqual(snapshot().counts,{first:1,second:2,pending:0});
assert.equal(snapshot().volumes.secondPi,'12.0000000');
assert.equal(sql.prepare('SELECT COUNT(*) n FROM historical_events').get().n,3);
assert.equal(sql.prepare('SELECT COUNT(*) n FROM focus_events').get().n,0);
assert.equal(sql.prepare('SELECT state FROM focus_control').get().state,'{"live":"preserved"}');
assert.equal(calls.includes('/accounts/'+SOURCE),false,'no source balance reads in historical collector');
await collectHistorical({DB});assert.equal(state().cursor,'70','historical collector extends to new source tip');
assert.equal(snapshot().counts.second,2);assert.equal(snapshot().volumes.secondPi,'12.0000000','third event excluded');
const again={...state(),cursor:'39',sourceComplete:false};sql.prepare('UPDATE historical_control SET state=?').run(JSON.stringify(again));
await collectHistorical({DB});assert.equal(snapshot().volumes.secondPi,'12.0000000','replay does not double count');
const count=calls.length;await collectHistorical({DB,HISTORICAL_ENABLED:'false'});assert.equal(calls.length,count);
// Missing ledger history must surface an error, never claim complete coverage.
sql.exec('DELETE FROM historical_control;DELETE FROM historical_events;DELETE FROM historical_wallets');pruned=true;
await collectHistorical({DB});assert.match(snapshot().error,/404/);assert.equal(snapshot().historical.sourceComplete,false);assert.equal(snapshot().counts,null);
// Budget stop preserves the search/source cursor for a later UTC day or budget increase.
pruned=false;await collectHistorical({DB,HISTORICAL_DAILY_WRITE_BUDGET:'1'});assert.match(snapshot().error,/budget/);assert.equal(state().startedAt,undefined);
sql.close();console.log('PASS historical: February boundary, empty ledger, first/second separation, cutoff and catch-up, cumulative Pi, replay, live isolation, disable switch, missing-history error and budget stop');
