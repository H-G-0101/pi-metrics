import {collectFocus} from './focus.mjs';

export const HISTORICAL_SINCE='2025-02-01T00:00:00.000Z';
const HIST_SOURCE='GABT7EMPGNCQSZM22DIYC4FNKHUVJTXITUF6Y5HNIWPU4GA7BHT4GC5G';
async function historicalJSON(path){
  const r=await fetch('https://api.mainnet.minepi.com'+path,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw new Error('Historical API HTTP '+r.status+'; search progress preserved');
  return r.json();
}
export async function initializeHistorical(state){
  const began=Date.now();
  let search=state.search?{...state.search}:null;
  if(!search){
    const ledger=(await historicalJSON('/ledgers?order=desc&limit=1'))._embedded?.records?.[0];
    const tip=(await historicalJSON('/accounts/'+HIST_SOURCE+'/operations?order=desc&limit=1'))._embedded?.records?.[0];
    if(!Number.isSafeInteger(ledger?.sequence)||!Number.isFinite(Date.parse(ledger.closed_at))||!/^\d+$/.test(tip?.paging_token||'')||!Number.isFinite(Date.parse(tip.created_at)))throw new Error('Invalid historical boundary response');
    if(Date.parse(ledger.closed_at)<Date.parse(HISTORICAL_SINCE)||Date.parse(tip.created_at)<Date.parse(HISTORICAL_SINCE))throw new Error('Source history does not reach the requested start date');
    search={low:1,high:ledger.sequence,endCursor:tip.paging_token,targetAt:tip.created_at};
  }
  // Locate the first ledger on/after the requested UTC date. Persist between ticks.
  for(let step=0;step<6&&search.low<search.high&&Date.now()-began<20000;step++){
    const middle=Math.floor((search.low+search.high)/2);
    const ledger=await historicalJSON('/ledgers/'+middle);
    if(ledger.sequence!==middle||!Number.isFinite(Date.parse(ledger.closed_at)))throw new Error('Invalid historical ledger; boundary not accepted');
    if(Date.parse(ledger.closed_at)<Date.parse(HISTORICAL_SINCE))search.low=middle+1;else search.high=middle;
  }
  if(search.low<search.high)return {search};
  // Read an actual operation token rather than guessing Horizon cursor encoding.
  for(let step=0;step<4&&Date.now()-began<25000;step++){
    const rows=(await historicalJSON('/ledgers/'+search.low+'/operations?order=asc&limit=1'))._embedded?.records;
    if(!Array.isArray(rows))throw new Error('Invalid historical operations response');
    if(rows.length){
      const op=rows[0];
      if(!/^\d+$/.test(op.paging_token)||Date.parse(op.created_at)<Date.parse(HISTORICAL_SINCE)||!Number.isFinite(Date.parse(op.created_at)))throw new Error('Invalid historical start operation');
      const cursor=String(BigInt(op.paging_token)-1n);
      return {search:null,startedAt:HISTORICAL_SINCE,cursor,endCursor:search.endCursor,targetAt:search.targetAt,sourceComplete:BigInt(cursor)>=BigInt(search.endCursor),counts:{first:0,second:0,pending:0},backlog:true};
    }
    search.low++;search.high=search.low;
  }
  return {search};
}
export function historicalDB(DB){
  // Dedicated tables, indexes, lock, cursors and totals in the existing database.
  return {prepare:sql=>DB.prepare(sql.replace(/\bfocus_/g,'historical_')),batch:statements=>DB.batch(statements)};
}
export async function collectHistorical(env){
  if(env.HISTORICAL_ENABLED==='false')return;
  if(!env.DB)throw new Error('DB binding required');
  return collectFocus({...env,DB:historicalDB(env.DB),
    FOCUS_DAILY_WRITE_BUDGET:env.HISTORICAL_DAILY_WRITE_BUDGET||'250000',
    FOCUS_HISTORY_WRITE_BUDGET:env.HISTORICAL_VERIFICATION_WRITE_BUDGET||'150000',
    FOCUS_HISTORY_PAGES:'40',FOCUS_HISTORY_CONCURRENCY:'2'
  },{historical:true,since:HISTORICAL_SINCE,initialize:initializeHistorical});
}
