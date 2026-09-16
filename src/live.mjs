// Independent near-live collector. No writes to historical wallet counters.
const LIVE_SOURCE='GABT7EMPGNCQSZM22DIYC4FNKHUVJTXITUF6Y5HNIWPU4GA7BHT4GC5G';
const LIVE_RECOVERY='GC5RNDCRO6DDM7NZDEMW3RIN5K6AHN6GMWSZ5SAH2TRJLVGQMB2I3BNJ';
export const liveSchema=[
  'CREATE TABLE IF NOT EXISTS live_control (id INTEGER PRIMARY KEY, state TEXT NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0, owner TEXT, snapshot TEXT)',
  "INSERT OR IGNORE INTO live_control(id,state) VALUES (1,'{}')",
  'CREATE TABLE IF NOT EXISTS live_receipt_ops (id TEXT PRIMARY KEY, address TEXT NOT NULL, hash TEXT NOT NULL, at TEXT NOT NULL, units INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS live_receipts (address TEXT NOT NULL, hash TEXT NOT NULL, at TEXT NOT NULL, units INTEGER NOT NULL, lockups INTEGER NOT NULL, PRIMARY KEY(address,hash))',
  'CREATE INDEX IF NOT EXISTS live_receipts_date ON live_receipts(at DESC)',
  'CREATE TABLE IF NOT EXISTS sync_state (name TEXT PRIMARY KEY, cursor TEXT, updated_at TEXT)',
];
export function liveReceipt(op){
  if(op.type!=='create_claimable_balance'||op.source_account!==LIVE_SOURCE||op.asset!=='native'||op.transaction_successful===false)return null;
  const recipients=(op.claimants||[]).filter(c=>c.destination && c.destination!==LIVE_SOURCE && c.destination!==LIVE_RECOVERY);
  if(recipients.length!==1)return null;
  if(!/^[0-9]+([.][0-9]{1,7})?$/.test(String(op.amount)))throw new Error('Invalid live amount');
  const [whole,fraction='']=String(op.amount).split('.');
  const units=BigInt(whole)*10000000n+BigInt(fraction.padEnd(7,'0'));
  if(units>9223372036854775807n)throw new Error('Live amount out of range');
  if(!op.paging_token||!op.transaction_hash||!Number.isFinite(Date.parse(op.created_at)))throw new Error('Incomplete live operation');
  return {id:String(op.id||op.paging_token),address:recipients[0].destination,hash:op.transaction_hash,at:op.created_at,units:String(units)};
}
export function liveRound(evidence,hash){
  if(evidence?.policyVersion!==29||!evidence.genesis||evidence.ambiguous)return null;
  const index=(evidence.events||[]).findIndex(e=>e.hash===hash);
  return index<0?null:index+1;
}
async function livePage(cursor,order){
  const url='https://api.mainnet.minepi.com/accounts/'+LIVE_SOURCE+'/operations?order='+order+'&limit=200'+(cursor?'&cursor='+encodeURIComponent(cursor):'');
  const response=await fetch(url,{signal:AbortSignal.timeout(10000),headers:{Accept:'application/json'}});
  if(!response.ok)throw new Error('Horizon HTTP '+response.status);
  const rows=(await response.json())._embedded?.records;
  if(!Array.isArray(rows))throw new Error('Invalid Horizon page');
  return rows;
}
export async function collectLive(env){
  if(!env.DB)throw new Error('DB binding required');
  await env.DB.batch(liveSchema.map(sql=>env.DB.prepare(sql)));
  const owner=crypto.randomUUID(),now=Date.now();
  const lease=await env.DB.prepare('UPDATE live_control SET owner=?1,lease_until=?2 WHERE id=1 AND lease_until<?3 RETURNING state,snapshot').bind(owner,now+180000,now).first();
  if(!lease)return;
  let state=JSON.parse(lease.state),problem=null;
  const day=new Date().toISOString().slice(0,10);
  if(state.day!==day){state.day=day;state.writes=0;state.backfillWrites=0;}
  const limit=Number(env.LIVE_DAILY_WRITE_BUDGET||65000);
  const backfillLimit=Math.min(Number(env.LIVE_BACKFILL_WRITE_BUDGET||3000),limit>0?limit*0.1:3000);
  // Keep the operation archive, but aggregate each transaction only once per page.
  // The lease prevents an older invocation from writing during this transition.
  await env.DB.prepare('DROP TRIGGER IF EXISTS live_receipt_insert').run();
  state.writes=Number(state.writes||0)+8; // reserve lease/schema/snapshot overhead
  let backfillPaused=false;
  async function commit(records,next,isBackfill=false){
    const candidates=[...new Map(records.map(liveReceipt).filter(Boolean).map(row=>[row.id,row])).values()];
    const existing=await env.DB.prepare("SELECT id FROM live_receipt_ops WHERE id IN (SELECT json_extract(value,'$.id') FROM json_each(?1))").bind(JSON.stringify(candidates)).all();
    const seen=new Set((existing.results||[]).map(row=>row.id));
    const receipts=candidates.filter(row=>!seen.has(row.id));
    const grouped=new Map();
    for(const row of receipts){
      const key=row.address+':'+row.hash,group=grouped.get(key)||{address:row.address,hash:row.hash,at:row.at,units:0n,lockups:0};
      group.units+=BigInt(row.units);group.lockups++;grouped.set(key,group);
    }
    const cost=receipts.length*2+grouped.size*3+2;
    if(isBackfill && (Number(state.backfillWrites||0)+cost>backfillLimit || (limit>0&&state.writes+cost>limit*0.5))){backfillPaused=true;return false;}
    if(limit>0 && state.writes+cost>limit)throw new Error('Live daily write budget reached; resumes next UTC day');
    const groups=[...grouped.values()].map(row=>({...row,units:String(row.units)}));
    const statements=[env.DB.prepare("INSERT OR IGNORE INTO live_receipt_ops(id,address,hash,at,units) SELECT json_extract(value,'$.id'),json_extract(value,'$.address'),json_extract(value,'$.hash'),json_extract(value,'$.at'),CAST(json_extract(value,'$.units') AS INTEGER) FROM json_each(?1) WHERE EXISTS(SELECT 1 FROM live_control WHERE id=1 AND owner=?2)").bind(JSON.stringify(receipts),owner),env.DB.prepare("INSERT INTO live_receipts(address,hash,at,units,lockups) SELECT json_extract(value,'$.address'),json_extract(value,'$.hash'),json_extract(value,'$.at'),CAST(json_extract(value,'$.units') AS INTEGER),json_extract(value,'$.lockups') FROM json_each(?1) WHERE EXISTS(SELECT 1 FROM live_control WHERE id=1 AND owner=?2) ON CONFLICT(address,hash) DO UPDATE SET units=live_receipts.units+excluded.units,lockups=live_receipts.lockups+excluded.lockups").bind(JSON.stringify(groups),owner)];
    next.writes=state.writes+cost;
    next.backfillWrites=Number(state.backfillWrites||0)+(isBackfill?cost:0);
    statements.push(env.DB.prepare('UPDATE live_control SET state=?1 WHERE id=1 AND owner=?2').bind(JSON.stringify(next),owner));
    const result=await env.DB.batch(statements);
    if(!result.at(-1).meta?.changes)throw new Error('Live collector lease lost');
    next.writes=state.writes+result.reduce((sum,r)=>sum+Number(r.meta?.rows_written||0),0);
    state=next;
    return true;
  }
  try{
    if(!state.cursor){
      const records=await livePage('','desc');
      if(records.length){
        const cutoff=new Date(now-86400000).toISOString();
        const relevant=records.filter(r=>r.created_at>=cutoff);
        await commit(relevant,{...state,cursor:records[0].paging_token,backfill:records.length===200&&relevant.length===records.length?records.at(-1).paging_token:null,cutoff,startedAt:new Date(now).toISOString(),backlog:false});
      }
    }else{
      for(let page=0;page<6 && Date.now()-now<45000;page++){
        const records=await livePage(state.cursor,'asc');
        if(records.length && BigInt(records.at(-1).paging_token)<=BigInt(state.cursor))throw new Error('Live cursor did not advance');
        await commit(records,{...state,cursor:records.at(-1)?.paging_token||state.cursor,backlog:records.length===200});
        if(records.length<200)break;
      }
    }
    state.checkedAt=new Date().toISOString();
    if(state.backfill && !state.backlog && Number(state.backfillWrites||0)<backfillLimit && (limit<=0||state.writes<limit*0.5)){
      const records=await livePage(state.backfill,'desc');
      if(records.length && BigInt(records.at(-1).paging_token)>=BigInt(state.backfill))throw new Error('Backfill cursor did not advance');
      const relevant=records.filter(r=>r.created_at>=state.cutoff);
      await commit(relevant,{...state,backfill:records.length<200||relevant.length<records.length?null:records.at(-1).paging_token},true);
    }else if(state.backfill){backfillPaused=true;}
  }catch(error){problem=error.message;console.error('Live collector:',problem);}
  try{
    const from=new Date(Date.now()-86400000).toISOString();
    const totals=await env.DB.prepare("WITH classified AS (SELECT r.*, CASE WHEN json_extract(s.cursor,'$.policyVersion')=29 AND json_extract(s.cursor,'$.genesis')=1 AND COALESCE(json_extract(s.cursor,'$.ambiguous'),0)=0 THEN (SELECT CAST(j.key AS INTEGER)+1 FROM json_each(s.cursor,'$.events') j WHERE json_extract(j.value,'$.hash')=r.hash LIMIT 1) ELSE NULL END AS round FROM live_receipts r LEFT JOIN sync_state s ON s.name='evidence:'||r.address WHERE r.at>=?1) SELECT COUNT(*) AS events,COUNT(DISTINCT address) AS wallets,COALESCE(SUM(round=1),0) AS first,COALESCE(SUM(round=2),0) AS second,COUNT(DISTINCT CASE WHEN round=2 THEN address END) AS secondWallets,COALESCE(SUM(round>2),0) AS later,COALESCE(SUM(round IS NULL),0) AS pending,CAST(COALESCE(SUM(units),0) AS TEXT) AS units FROM classified").bind(from).first();
    const totalUnits=BigInt(totals.units);
    const metrics24h={...totals,amountPi:(totalUnits/10000000n)+'.'+String(totalUnits%10000000n).padStart(7,'0'),from,complete:!!state.cutoff&&state.cutoff<=from&&!state.backfill&&!state.backlog&&!problem};
    const results=await env.DB.prepare('SELECT address,hash,at,CAST(units AS TEXT) AS units,lockups FROM live_receipts ORDER BY at DESC,address,hash LIMIT 20').all();
    const events=[];
    for(const row of results.results||[]){
      let evidence=null;
      try{const saved=await env.DB.prepare('SELECT cursor FROM sync_state WHERE name=?1').bind('evidence:'+row.address).first();evidence=saved?JSON.parse(saved.cursor):null;}catch{/* Historical collector may not have initialized its tables. */}
      const units=BigInt(row.units);
      events.push({...row,amountPi:(units/10000000n)+'.'+String(units%10000000n).padStart(7,'0'),migrationNumber:liveRound(evidence,row.hash)});
    }
    // Ranking is cached independently; its failure must not hide migration counts.
    let ranking=lease.snapshot?JSON.parse(lease.snapshot).ranking:null;
    if(!ranking||Date.now()-Date.parse(ranking.updatedAt)>=300000){
      try{
        const rankingFrom=new Date(Date.now()-7*86400000).toISOString();
        const result=await env.DB.prepare('SELECT address,CAST(SUM(units) AS TEXT) AS units,SUM(lockups) AS balanceCount,COUNT(*) AS eventCount,MAX(at) AS latestAt FROM live_receipts WHERE at>=?1 GROUP BY address ORDER BY SUM(units) DESC,address LIMIT 20').bind(rankingFrom).all();
        const rows=[];
        for(const row of result.results||[]){
          const saved=await env.DB.prepare('SELECT cursor FROM sync_state WHERE name=?1').bind('evidence:'+row.address).first();
          const evidence=saved?JSON.parse(saved.cursor):null;
          const receipts=await env.DB.prepare('SELECT hash,at FROM live_receipts WHERE address=?1 AND at>=?2 ORDER BY at,hash').bind(row.address,rankingFrom).all();
          const numbers=(receipts.results||[]).map(r=>liveRound(evidence,r.hash));
          const types=[...new Set(numbers.map(n=>n==null?'awaiting classification':n===1?'1st':n===2?'2nd':'later'))];
          const units=BigInt(row.units);
          rows.push({...row,rank:rows.length+1,amountPi:(units/10000000n)+'.'+String(units%10000000n).padStart(7,'0'),migrationType:types.join(' & '),tranches:[],evidence:(receipts.results||[]).map((r,i)=>({transactionHash:r.hash,createdAt:r.at,migrationNumber:numbers[i],status:numbers[i]?'Confirmed':'Pending',method:numbers[i]?'wallet_history':'Historical verification pending',checkedAt:evidence?.checkedAt||null}))});
        }
        ranking={rows,from:rankingFrom,coverageFrom:state.cutoff||state.startedAt,updatedAt:new Date().toISOString(),complete:!!state.cutoff&&state.cutoff<=rankingFrom&&!state.backfill&&!state.backlog&&!problem};
      }catch(error){ranking={...(ranking||{rows:[]}),updatedAt:ranking?.updatedAt||null,error:error.message};}
    }
    const snapshot=JSON.stringify({version:34,metrics24h,ranking,source:LIVE_SOURCE,checkedAt:state.checkedAt||null,reportedAt:new Date().toISOString(),startedAt:state.startedAt||null,backfilling:!!state.backfill,backfillPaused,backlog:!!state.backlog,error:problem,events});
    await env.DB.prepare('UPDATE live_control SET snapshot=?1 WHERE id=1 AND owner=?2').bind(snapshot,owner).run();
  }finally{
    await env.DB.prepare('UPDATE live_control SET state=?1,lease_until=0,owner=NULL WHERE id=1 AND owner=?2').bind(JSON.stringify(state),owner).run();
  }
}
