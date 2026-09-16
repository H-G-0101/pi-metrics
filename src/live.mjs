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
  'CREATE TRIGGER IF NOT EXISTS live_receipt_insert AFTER INSERT ON live_receipt_ops BEGIN INSERT INTO live_receipts(address,hash,at,units,lockups) VALUES(new.address,new.hash,new.at,new.units,1) ON CONFLICT(address,hash) DO UPDATE SET units=live_receipts.units+new.units,lockups=live_receipts.lockups+1; END',
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
  const lease=await env.DB.prepare('UPDATE live_control SET owner=?1,lease_until=?2 WHERE id=1 AND lease_until<?3 RETURNING state').bind(owner,now+180000,now).first();
  if(!lease)return;
  let state=JSON.parse(lease.state),problem=null;
  const day=new Date().toISOString().slice(0,10);
  if(state.day!==day){state.day=day;state.writes=0;}
  const limit=Number(env.LIVE_DAILY_WRITE_BUDGET||30000);
  async function commit(records,next){
    const receipts=records.map(liveReceipt).filter(Boolean);
    // Reserve for PK, event upsert, date index and control writes; actual usage follows.
    if(limit>0 && state.writes+receipts.length*6+2>limit)throw new Error('Live daily write budget reached; resumes next UTC day');
    const statements=[env.DB.prepare("INSERT OR IGNORE INTO live_receipt_ops(id,address,hash,at,units) SELECT json_extract(value,'$.id'),json_extract(value,'$.address'),json_extract(value,'$.hash'),json_extract(value,'$.at'),CAST(json_extract(value,'$.units') AS INTEGER) FROM json_each(?1) WHERE EXISTS(SELECT 1 FROM live_control WHERE id=1 AND owner=?2)").bind(JSON.stringify(receipts),owner)];
    next.writes=state.writes+receipts.length*6+2;
    statements.push(env.DB.prepare('UPDATE live_control SET state=?1 WHERE id=1 AND owner=?2').bind(JSON.stringify(next),owner));
    const result=await env.DB.batch(statements);
    if(!result.at(-1).meta?.changes)throw new Error('Live collector lease lost');
    next.writes=state.writes+result.reduce((sum,r)=>sum+Number(r.meta?.rows_written||0),0);
    state=next;
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
      for(let page=0;page<2;page++){
        const records=await livePage(state.cursor,'asc');
        if(records.length && BigInt(records.at(-1).paging_token)<=BigInt(state.cursor))throw new Error('Live cursor did not advance');
        await commit(records,{...state,cursor:records.at(-1)?.paging_token||state.cursor,backlog:records.length===200});
        if(records.length<200)break;
      }
    }
    if(state.backfill){
      const records=await livePage(state.backfill,'desc');
      if(records.length && BigInt(records.at(-1).paging_token)>=BigInt(state.backfill))throw new Error('Backfill cursor did not advance');
      const relevant=records.filter(r=>r.created_at>=state.cutoff);
      await commit(relevant,{...state,backfill:records.length<200||relevant.length<records.length?null:records.at(-1).paging_token});
    }
    state.checkedAt=new Date().toISOString();
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
    const snapshot=JSON.stringify({version:31,metrics24h,source:LIVE_SOURCE,checkedAt:state.checkedAt||null,reportedAt:new Date().toISOString(),startedAt:state.startedAt||null,backfilling:!!state.backfill,backlog:!!state.backlog,error:problem,events});
    await env.DB.prepare('UPDATE live_control SET snapshot=?1 WHERE id=1 AND owner=?2').bind(snapshot,owner).run();
  }finally{
    await env.DB.prepare('UPDATE live_control SET state=?1,lease_until=0,owner=NULL WHERE id=1 AND owner=?2').bind(JSON.stringify(state),owner).run();
  }
}
