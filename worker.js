// Generated v41: focused migration collector and cached source balance.
// v36: new receipts only, persistent ordinal evidence, no rolling analytics.
const SOURCE='GABT7EMPGNCQSZM22DIYC4FNKHUVJTXITUF6Y5HNIWPU4GA7BHT4GC5G';
const RECOVERY='GC5RNDCRO6DDM7NZDEMW3RIN5K6AHN6GMWSZ5SAH2TRJLVGQMB2I3BNJ';
const API='https://api.mainnet.minepi.com';
const focusSchema=[
  'CREATE TABLE IF NOT EXISTS focus_control(id INTEGER PRIMARY KEY,state TEXT NOT NULL,snapshot TEXT,owner TEXT,lease_until INTEGER NOT NULL DEFAULT 0)',
  "INSERT OR IGNORE INTO focus_control(id,state) VALUES(1,'{}')",
  'CREATE TABLE IF NOT EXISTS focus_events(address TEXT NOT NULL,hash TEXT NOT NULL,at TEXT NOT NULL,units TEXT NOT NULL,ids TEXT NOT NULL,round INTEGER,PRIMARY KEY(address,hash))',
  'CREATE INDEX IF NOT EXISTS focus_event_date ON focus_events(at)',
  'CREATE TABLE IF NOT EXISTS focus_wallets(address TEXT PRIMARY KEY,evidence TEXT NOT NULL,pending INTEGER NOT NULL,retry_at TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS focus_pending ON focus_wallets(retry_at,address) WHERE pending>0',
];
function focusReceipt(op){
  if(op.type!=='create_claimable_balance'||op.source_account!==SOURCE||op.asset!=='native'||op.transaction_successful===false)return null;
  const targets=(op.claimants||[]).filter(c=>c.destination&&c.destination!==SOURCE&&c.destination!==RECOVERY);
  if(targets.length!==1)return null;
  if(!/^\d+(\.\d{1,7})?$/.test(String(op.amount)))throw new Error('Invalid migration amount');
  const [whole,fraction='']=String(op.amount).split('.');
  const units=BigInt(whole)*10000000n+BigInt(fraction.padEnd(7,'0'));
  if(units>9223372036854775807n)throw new Error('Migration amount too large');
  return {address:targets[0].destination,hash:op.transaction_hash,at:new Date(op.created_at).toISOString(),units:String(units),id:String(op.id||op.paging_token)};
}
function focusRound(evidence,hash){
  if(evidence.birthHash===hash)return 1;
  if(evidence.policyVersion!==29||!evidence.genesis||evidence.ambiguous)return null;
  const index=(evidence.events||[]).findIndex(e=>e.hash===hash);
  return index<0?null:index+1;
}
async function focusPage(address,cursor,order='asc',limit=200){
  const response=await fetch(API+'/accounts/'+address+'/operations?order='+order+'&limit='+limit+(cursor?'&cursor='+encodeURIComponent(cursor):''),{headers:{Accept:'application/json'},signal:AbortSignal.timeout(10000)});
  if(!response.ok){const error=new Error('Pi API HTTP '+response.status);error.status=response.status;throw error;}
  const rows=(await response.json())._embedded?.records;
  if(!Array.isArray(rows)||rows.some(r=>!/^\d+$/.test(String(r.paging_token))||!Number.isFinite(Date.parse(r.created_at))||!r.transaction_hash))throw new Error('Invalid operations page; cursor preserved');
  for(let i=1;i<rows.length;i++)if(order==='asc'?BigInt(rows[i].paging_token)<=BigInt(rows[i-1].paging_token):BigInt(rows[i].paging_token)>=BigInt(rows[i-1].paging_token))throw new Error('Unordered operations page');
  if(cursor&&rows.length&&(order==='asc'?BigInt(rows[0].paging_token)<=BigInt(cursor):BigInt(rows[0].paging_token)>=BigInt(cursor)))throw new Error('Cursor did not advance');
  return rows;
}
function counts(events){return {first:Number(events.some(e=>e.round===1)),second:Number(events.some(e=>e.round===2)),pending:events.filter(e=>e.round==null).length};}
function decimal(units){const n=BigInt(units);return (n/10000000n)+'.'+String(n%10000000n).padStart(7,'0');}
async function focusVerificationQueue(DB,ranking,now,size=4){
  size=Math.max(4,Math.min(80,Math.floor(size)||4));
  const prioritySize=Math.min(20,size-1);
  // Reuse the published ranking; never aggregate the seven-day window per tick.
  const top=[...new Set((ranking?.rows||[]).slice(0,20).map(r=>r.address))];
  const general=(await DB.prepare('SELECT address FROM focus_wallets WHERE pending>0 AND retry_at<=?1 ORDER BY retry_at,address LIMIT ?2').bind(now,size).all()).results||[];
  const priority=top.length?(await DB.prepare('SELECT address FROM focus_wallets WHERE address IN (SELECT value FROM json_each(?1)) AND pending>0 AND retry_at<=?2 ORDER BY retry_at,address LIMIT ?3').bind(JSON.stringify(top),now,prioritySize).all()).results||[]:[];
  // Reserve the first slot for the oldest non-priority candidate, then up to
  // three Top 20 candidates. Fill unused slots without repeats or extra pages.
  const selected=new Set(priority.map(r=>r.address));
  const fair=general.find(r=>!selected.has(r.address));
  return [...new Set([...(fair?[fair.address]:[]),...priority.map(r=>r.address),...general.map(r=>r.address)])].slice(0,size);
}
async function collectFocus(env,options={}){
  if(!env.DB)throw new Error('DB binding required');
  const DB=env.DB;
  await DB.batch(focusSchema.map(sql=>DB.prepare(sql)));
  const now=Date.now(),owner=crypto.randomUUID();
  const lease=await DB.prepare('UPDATE focus_control SET owner=?1,lease_until=?2 WHERE id=1 AND lease_until<?3 RETURNING state,snapshot').bind(owner,now+180000,now).first();
  if(!lease)return;
  let state=JSON.parse(lease.state),error=null,historyError=null;
  const day=new Date().toISOString().slice(0,10);
  if(state.day!==day){state.day=day;state.writes=0;state.historyWrites=0;}
  state.writes=Number(state.writes||0)+8;
  const setting=(key,fallback,min,max)=>{const n=Number(env[key]);return Number.isFinite(n)&&n>=min?Math.min(max,Math.floor(n)):fallback;};
  const limit=setting('FOCUS_DAILY_WRITE_BUDGET',1000000,1,5000000),historyLimit=setting('FOCUS_HISTORY_WRITE_BUDGET',400000,1,5000000);
  const historyPages=setting('FOCUS_HISTORY_PAGES',80,4,80),concurrency=setting('FOCUS_HISTORY_CONCURRENCY',4,1,4);
  async function save(next,events=[],wallets=[]){
    const cost=events.length*3+wallets.length*3+1;
    if(limit>0&&state.writes+cost>limit)throw new Error('Daily storage budget reached; resumes next UTC day');
    next.writes=state.writes+cost;
    const statements=[
      DB.prepare("INSERT INTO focus_events(address,hash,at,units,ids,round) SELECT json_extract(value,'$.address'),json_extract(value,'$.hash'),json_extract(value,'$.at'),json_extract(value,'$.units'),json_extract(value,'$.ids'),json_extract(value,'$.round') FROM json_each(?1) WHERE EXISTS(SELECT 1 FROM focus_control WHERE owner=?2) ON CONFLICT(address,hash) DO UPDATE SET units=excluded.units,ids=excluded.ids,round=excluded.round").bind(JSON.stringify(events),owner),
      DB.prepare("INSERT INTO focus_wallets(address,evidence,pending,retry_at) SELECT json_extract(value,'$.address'),json_extract(value,'$.evidence'),json_extract(value,'$.pending'),json_extract(value,'$.retry_at') FROM json_each(?1) WHERE EXISTS(SELECT 1 FROM focus_control WHERE owner=?2) ON CONFLICT(address) DO UPDATE SET evidence=excluded.evidence,pending=excluded.pending,retry_at=excluded.retry_at").bind(JSON.stringify(wallets),owner),
      DB.prepare('UPDATE focus_control SET state=?1 WHERE id=1 AND owner=?2').bind(JSON.stringify(next),owner),
    ];
    const result=await DB.batch(statements);
    if(!result.at(-1).meta?.changes)throw new Error('Collector lease lost');
    state=next;
  }
  async function load(addresses){
    const args=JSON.stringify(addresses);
    const result=await DB.batch([
      DB.prepare('SELECT * FROM focus_events WHERE address IN (SELECT value FROM json_each(?1))').bind(args),
      DB.prepare('SELECT * FROM focus_wallets WHERE address IN (SELECT value FROM json_each(?1))').bind(args),
    ]);
    return {events:result[0].results||[],wallets:new Map((result[1].results||[]).map(w=>[w.address,JSON.parse(w.evidence)]))};
  }
  function prepareChanges(addresses,previous,events,evidence,next,retryAt){
    const changed=[],wallets=[];
    next.counts={...state.counts};
    next.volumeUnits={...state.volumeUnits};
    for(const address of addresses){
      const before=previous.filter(e=>e.address===address),after=events.filter(e=>e.address===address),proof=evidence.get(address);
      for(const event of after){
        event.round=focusRound(proof,event.hash);
        const old=before.find(e=>e.hash===event.hash);
        if(!old||old.units!==event.units||old.ids!==event.ids||old.round!==event.round)changed.push(event);
      }
      const a=counts(before),b=counts(after);
      for(const k of ['first','second','pending'])next.counts[k]+=b[k]-a[k];
      for(const [key,round] of [['first',1],['second',2]]){
        const sum=rows=>rows.filter(e=>e.round===round).reduce((total,e)=>total+BigInt(e.units),0n);
        next.volumeUnits[key]=String(BigInt(next.volumeUnits[key]||'0')+sum(after)-sum(before));
      }
      const retry=retryAt&&proof.complete&&(!proof.genesis||proof.ambiguous)?new Date(Date.now()+86400000).toISOString():retryAt;
      wallets.push({address,evidence:JSON.stringify(proof),pending:b.pending,retry_at:retry||new Date().toISOString()});
    }
    return {changed,wallets};
  }
  try{
    // One-time upgrade from stored epoch receipts; no blockchain backfill.
    if(!state.volumeUnits){
      const rows=(await DB.prepare('SELECT round,CAST(SUM(CAST(units AS INTEGER)) AS TEXT) AS units FROM focus_events WHERE round IN (1,2) GROUP BY round').all()).results||[];
      state.volumeUnits={first:'0',second:'0'};
      for(const row of rows)state.volumeUnits[row.round===1?'first':'second']=row.units;
    }
    if(!state.lastMigrationLoaded){
      const latest=await DB.prepare('SELECT at,hash FROM focus_events ORDER BY at DESC LIMIT 1').first();
      state.lastMigrationAt=latest?.at||null;state.lastMigrationHash=latest?.hash||null;state.lastMigrationLoaded=true;
    }
    if(options.historical&&!state.startedAt){
      await save({...state,...await options.initialize(state)});
    }
    if(!options.historical&&!state.startedAt){
      // A new epoch starts at the latest operation, never at an old backlog cursor.
      // Carry known same-day usage so activation cannot reset the storage allowance.
      if(!state.legacyUsageImported){
        try{const old=await DB.prepare('SELECT state FROM live_control WHERE id=1').first();const usage=old?JSON.parse(old.state):null;if(usage?.day===day)state.writes+=Number(usage.writes||0);}catch(e){if(!String(e.message).includes('no such table'))throw e;}
        state.legacyUsageImported=true;
      }
      const latest=await focusPage(SOURCE,'','desc',1);
      await save({...state,startedAt:new Date().toISOString(),cursor:latest[0]?.paging_token||'0',counts:{first:0,second:0,pending:0},backlog:false});
    }
    if(options.historical&&state.startedAt&&state.sourceComplete){
      const tip=(await focusPage(SOURCE,'','desc',1))[0];
      if(!tip)throw new Error('Historical source tip unavailable');
      if(BigInt(tip.paging_token)>BigInt(state.endCursor))await save({...state,endCursor:tip.paging_token,targetAt:tip.created_at,sourceComplete:false});
      else await save({...state,checkedAt:new Date().toISOString()});
    }
    for(let page=0;state.startedAt&&!(options.historical&&state.sourceComplete)&&page<(options.historical?6:3)&&Date.now()-now<35000;page++){
      const fetched=await focusPage(SOURCE,state.cursor);
      const records=options.historical?fetched.filter(r=>BigInt(r.paging_token)<=BigInt(state.endCursor)):fetched;
      const complete=options.historical&&(BigInt(records.at(-1)?.paging_token||state.cursor)>=BigInt(state.endCursor));
      if(options.historical&&fetched.length<200&&!complete)throw new Error('Historical page ended before the known target; coverage cannot be confirmed');
      const receipts=records.map(focusReceipt).filter(r=>r&&(!options.historical||r.at>=state.startedAt));
      const births=records.filter(r=>r.type==='create_account'&&r.source_account===SOURCE&&r.transaction_successful!==false&&r.account&&(!options.historical||r.created_at>=state.startedAt));
      const addresses=[...new Set([...receipts.map(r=>r.address),...births.map(r=>r.account)])];
      const prior=await load(addresses),evidence=prior.wallets;
      const missing=addresses.filter(a=>!evidence.has(a));
      if(missing.length){
        // Reuse existing evidence, but never trust old aggregate guesses.
        let saved=[];
        try{saved=(await DB.prepare("SELECT name,cursor FROM sync_state WHERE name IN (SELECT 'evidence:'||value FROM json_each(?1))").bind(JSON.stringify(missing)).all()).results||[];}catch(e){if(!String(e.message).includes('no such table'))throw e;}
        for(const row of saved){const proof=JSON.parse(row.cursor);if(proof.policyVersion===29)evidence.set(row.name.slice(9),proof);}
        for(const a of missing)if(!evidence.has(a))evidence.set(a,{policyVersion:29,cursor:'',events:[],genesis:false,ambiguous:false});
      }
      for(const birth of births)evidence.get(birth.account).birthHash=birth.transaction_hash;
      const events=new Map(prior.events.map(e=>[e.address+':'+e.hash,{...e}]));
      for(const receipt of receipts){
        const key=receipt.address+':'+receipt.hash;
        const event=events.get(key)||{address:receipt.address,hash:receipt.hash,at:receipt.at,units:'0',ids:'[]',round:null};
        const ids=JSON.parse(event.ids);
        if(!ids.includes(receipt.id)){ids.push(receipt.id);event.units=String(BigInt(event.units)+BigInt(receipt.units));event.ids=JSON.stringify(ids);}
        events.set(key,event);
      }
      const next={...state,cursor:records.at(-1)?.paging_token||state.cursor,backlog:records.length===200,checkedAt:new Date().toISOString()};
      if(options.historical){next.sourceComplete=complete;next.backlog=!complete;next.scannedThrough=records.at(-1)?.created_at||state.scannedThrough;next.pagesScanned=(state.pagesScanned||0)+1;}
      for(const receipt of receipts)if(!next.lastMigrationAt||receipt.at>=next.lastMigrationAt){next.lastMigrationAt=receipt.at;next.lastMigrationHash=receipt.hash;}
      const changes=prepareChanges(addresses,prior.events,[...events.values()],evidence,next);
      await save(next,changes.changed,changes.wallets);
      if(records.length<200)break;
    }
  }catch(e){error=e.message;}
  // Paid profile: bounded parallel requests, incremental batch commits and API backoff.
  if(state.startedAt&&!error&&state.historyWrites<historyLimit&&Date.now()-now<45000&&Number(state.historyPauseUntil||0)<=Date.now()){
    try{
      const addresses=await focusVerificationQueue(DB,lease.snapshot?JSON.parse(lease.snapshot).ranking:null,new Date().toISOString(),historyPages);
      let stop=false;
      for(let offset=0;offset<addresses.length&&!stop&&Date.now()-now<45000;offset+=concurrency){
        const batch=addresses.slice(offset,offset+concurrency);
        const prior=await load(batch),evidence=prior.wallets;
        // Reserve enough for all potentially reclassified events before requesting a page.
        const maximumCost=prior.events.length*3+batch.length*3+1;
        if(state.historyWrites+maximumCost>historyLimit||state.writes+maximumCost>limit)break;
        let pauseUntil=0;
        const outcomes=await Promise.allSettled(batch.map(async address=>{
          const proof=evidence.get(address);
          try{
            const records=await focusPage(address,proof.cursor||'');
            if(!proof.cursor&&records.length)proof.genesis=records[0].type==='create_account'&&records[0].account===address;
            proof.events||=[];
            for(const op of records){
              const receipt=focusReceipt(op);
              if(op.type==='create_claimable_balance'&&op.source_account===SOURCE&&op.asset==='native'&&op.transaction_successful!==false&&(op.claimants||[]).some(c=>c.destination===address)&&!receipt)proof.ambiguous=true;
              if(receipt?.address===address&&!proof.events.some(e=>e.hash===receipt.hash))proof.events.push({hash:receipt.hash,at:receipt.at});
            }
            proof.cursor=records.at(-1)?.paging_token||proof.cursor;proof.checkedAt=new Date().toISOString();proof.complete=records.length<200;
            if(!proof.genesis)proof.error='Account creation was not present at the start of available history';else delete proof.error;
          }catch(e){
            historyError=e.message;proof.error=e.message;
            if(e.status===429||e.status>=500){stop=true;pauseUntil=Date.now()+300000;}
          }
        }));
        for(const outcome of outcomes)if(outcome.status==='rejected')throw outcome.reason;
        const next={...state,historyPauseUntil:pauseUntil};
        const changes=prepareChanges(batch,prior.events,prior.events.map(e=>({...e})),evidence,next,new Date(Date.now()+60000).toISOString());
        for(const wallet of changes.wallets)if(evidence.get(wallet.address).error)wallet.retry_at=new Date(Date.now()+300000).toISOString();
        const cost=changes.changed.length*3+changes.wallets.length*3+1;
        next.historyWrites=state.historyWrites+cost;
        await save(next,changes.changed,changes.wallets);
      }
    }catch(e){historyError=e.message;}
  }
  try{
    let ranking=lease.snapshot?JSON.parse(lease.snapshot).ranking:null;
    if(!options.historical&&state.startedAt&&(!ranking||Date.now()-Date.parse(ranking.updatedAt)>=300000)){
      try{
        const from=new Date(Date.now()-7*86400000).toISOString();
        const rows=(await DB.prepare('SELECT address,CAST(SUM(CAST(units AS INTEGER)) AS TEXT) AS units,MAX(round=1) AS first,MAX(round=2) AS second,MAX(round>2) AS later,MAX(round IS NULL) AS pending FROM focus_events WHERE at>=?1 GROUP BY address ORDER BY SUM(CAST(units AS INTEGER)) DESC,address LIMIT 20').bind(from).all()).results||[];
        ranking={updatedAt:new Date().toISOString(),complete:state.startedAt<=from&&!state.backlog&&!error,rows:rows.map((r,i)=>({rank:i+1,address:r.address,amountPi:decimal(r.units),type:[r.first?'1st':null,r.second?'2nd':null,r.later?'Later':null,r.pending?'Pending':null].filter(Boolean).join(' / ')}))};
      }catch(e){ranking={...(ranking||{rows:[]}),error:e.message};}
    }
    // The source balance is independent of receipts and never blocks their commit.
    let sourceAccount=lease.snapshot?JSON.parse(lease.snapshot).sourceAccount:null;
    if(!options.historical&&(!sourceAccount||Date.now()-Date.parse(sourceAccount.attemptedAt||0)>=300000)){
      const attemptedAt=new Date().toISOString();
      try{
        const response=await fetch(API+'/accounts/'+SOURCE,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(10000)});
        if(!response.ok)throw new Error('Source balance HTTP '+response.status);
        const account=await response.json();
        const balance=(account.balances||[]).find(b=>b.asset_type==='native')?.balance;
        if(!/^\d+(\.\d{1,7})?$/.test(String(balance)))throw new Error('Source balance unavailable');
        sourceAccount={address:SOURCE,balance,checkedAt:attemptedAt,attemptedAt,error:null};
      }catch(e){sourceAccount={...(sourceAccount||{address:SOURCE,balance:null,checkedAt:null}),attemptedAt,error:e.message};}
    }
    const volumes=state.startedAt&&state.volumeUnits?{firstPi:decimal(state.volumeUnits.first),secondPi:decimal(state.volumeUnits.second)}:null;
    const historical=options.historical?{since:options.since,targetAt:state.targetAt||null,scannedThrough:state.scannedThrough||null,pagesScanned:state.pagesScanned||0,sourceComplete:!!state.sourceComplete,initializing:!state.startedAt,scope:SOURCE}:null;
    const snapshot={version:41,historical,volumes,sourceAccount,lastMigrationAt:state.lastMigrationAt||null,lastMigrationHash:state.lastMigrationHash||null,startedAt:state.startedAt||null,checkedAt:state.checkedAt||null,counts:state.counts||null,backlog:!!state.backlog,error,historyError,ranking};
    await DB.prepare('UPDATE focus_control SET snapshot=?1,state=?2,owner=NULL,lease_until=0 WHERE id=1 AND owner=?3').bind(JSON.stringify(snapshot),JSON.stringify(state),owner).run();
  }finally{
    await DB.prepare('UPDATE focus_control SET owner=NULL,lease_until=0 WHERE id=1 AND owner=?1').bind(owner).run();
  }
}



const HISTORICAL_SINCE='2026-02-01T00:00:00.000Z';
const HIST_SOURCE='GABT7EMPGNCQSZM22DIYC4FNKHUVJTXITUF6Y5HNIWPU4GA7BHT4GC5G';
async function historicalJSON(path){
  const r=await fetch('https://api.mainnet.minepi.com'+path,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw new Error('Historical API HTTP '+r.status+'; search progress preserved');
  return r.json();
}
async function initializeHistorical(state){
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
function historicalDB(DB){
  // Dedicated tables, indexes, lock, cursors and totals in the existing database.
  return {prepare:sql=>DB.prepare(sql.replace(/\bfocus_/g,'historical_')),batch:statements=>DB.batch(statements)};
}
async function collectHistorical(env){
  if(env.HISTORICAL_ENABLED==='false')return;
  if(!env.DB)throw new Error('DB binding required');
  return collectFocus({...env,DB:historicalDB(env.DB),
    FOCUS_DAILY_WRITE_BUDGET:env.HISTORICAL_DAILY_WRITE_BUDGET||'250000',
    FOCUS_HISTORY_WRITE_BUDGET:env.HISTORICAL_VERIFICATION_WRITE_BUDGET||'150000',
    FOCUS_HISTORY_PAGES:'40',FOCUS_HISTORY_CONCURRENCY:'2'
  },{historical:true,since:HISTORICAL_SINCE,initialize:initializeHistorical});
}

const PAGE="<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Pi Migration Monitor</title>\n<style>\n:root{color-scheme:dark;--bg:#0b0e17;--panel:#121827;--edge:#273147;--muted:#9aa8bf;--ink:#f2f5ff;--purple:#bd8aff;--green:#4cdeb0}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,sans-serif}main{max-width:1100px;margin:auto;padding:48px 24px}header{display:flex;align-items:center;justify-content:space-between;gap:20px}h1{font-size:30px;letter-spacing:-1px;margin:8px 0}h2{font-size:20px;margin:0}.eyebrow{color:var(--green);font-size:12px;text-transform:uppercase;letter-spacing:2px}.muted{color:var(--muted);font-size:14px;line-height:1.6}.chip{border:1px solid var(--edge);border-radius:30px;padding:8px 14px;color:var(--green);font-size:13px;white-space:nowrap}.chip.warn{color:#ffd586}.stats{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin:30px 0}.card,.ranking{background:var(--panel);border:1px solid var(--edge);border-radius:20px}.card{padding:28px;border-top:3px solid var(--purple)}.card.second{border-top-color:var(--green)}.label{font-size:15px;color:var(--muted)}.value{display:block;font-size:clamp(40px,6vw,64px);font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-2px;color:var(--purple);margin:14px 0}.second .value{color:var(--green)}.card p{margin:0}.status{border-left:3px solid var(--edge);padding:4px 14px;margin:0 0 30px}.status p{margin:4px 0}.ranking{overflow:hidden}.heading{padding:25px}.heading p{margin:8px 0 0}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:14px}th{text-align:left;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);padding:16px 22px;border-top:1px solid var(--edge)}td{padding:19px 22px;border-top:1px solid var(--edge)}tbody tr:nth-child(odd){background:#192235}tbody tr:nth-child(even){background:#111826}.amount{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.wallet{display:flex;align-items:center;gap:10px;white-space:nowrap}.wallet a{color:var(--ink);text-decoration:none;font-family:monospace}.copy{background:#26344c;color:#d5e0f5;border:1px solid #3a4963;border-radius:7px;padding:6px 9px;cursor:pointer}.copy:hover{background:#374b6c}.type{color:var(--green);font-size:12px}.empty{padding:30px;text-align:center;color:var(--muted)}details{margin-top:26px;color:var(--muted);font-size:13px;line-height:1.8}summary{cursor:pointer}footer{margin-top:28px;font-size:12px;color:var(--muted)}@media(max-width:600px){main{padding:28px 16px}header{align-items:flex-start}.stats{gap:12px}.card{padding:19px 15px}.label{font-size:13px}.card p{font-size:12px}th,td{padding:15px 12px}h1{font-size:25px}.chip{font-size:11px;padding:7px 10px}}\n.source{margin-top:24px;border:1px solid var(--edge);border-radius:16px;padding:22px;background:var(--panel)}.source-address{display:flex;align-items:center;gap:12px;margin:12px 0 22px}.source-address a{color:var(--ink);font-family:monospace;overflow-wrap:anywhere;min-width:0;text-decoration:none;font-size:13px}.source-address button{flex-shrink:0}.source-metrics{display:grid;grid-template-columns:1fr 1fr;gap:24px}.source-metrics strong{display:block;margin:6px 0;font-size:24px;color:var(--green);font-variant-numeric:tabular-nums}.source-metrics p{margin:0;font-size:12px}@media(max-width:600px){.source{padding:18px}.source-metrics{grid-template-columns:1fr;gap:18px}}\n.migration-volume{border-top:1px solid var(--edge);margin-top:16px;padding-top:14px}.migration-volume strong{display:block;font-size:clamp(22px,3vw,30px);color:var(--purple);font-variant-numeric:tabular-nums}.second .migration-volume strong{color:var(--green)}.migration-volume span{font-size:12px;color:var(--muted)}.historical{margin-top:28px;padding:24px;border:1px solid #365577;border-top:3px solid #7abaff;border-radius:20px;background:#111c2c}.historical-header{display:flex;align-items:center;justify-content:space-between;gap:16px}.historical-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin:22px 0}.historical-grid strong{display:block;font-size:clamp(28px,4vw,42px);color:#9bcbff;font-variant-numeric:tabular-nums;margin-top:6px}.historical .muted{margin:8px 0}.historical .label{font-size:13px}@media(max-width:600px){.historical{padding:18px}.historical-header{align-items:flex-start}.historical-header h2{font-size:18px}.historical-grid{gap:14px}}</style></head><body><main>\n<header><div><span class=\"eyebrow\">Pi Network · Mainnet</span><h1>Migration monitor</h1><p class=\"muted\" id=\"period\">Waiting for collection to start</p></div><span id=\"health\" class=\"chip warn\">Connecting</span></header>\n<section class=\"source\" aria-label=\"Migration source wallet\"><span class=\"label\">Migration source wallet</span><div class=\"source-address\"><a id=\"sourceAddress\" href=\"https://blockexplorer.minepi.com/mainnet/accounts/GABT7EMPGNCQSZM22DIYC4FNKHUVJTXITUF6Y5HNIWPU4GA7BHT4GC5G\" target=\"_blank\" rel=\"noopener\">GABT7EMPGNCQSZM22DIYC4FNKHUVJTXITUF6Y5HNIWPU4GA7BHT4GC5G</a><button id=\"sourceCopy\" class=\"copy\" aria-label=\"Copy migration source wallet\">Copy</button></div><div class=\"source-metrics\"><div><span class=\"label\">Wallet balance</span><strong id=\"sourceBalance\">—</strong><p class=\"muted\" id=\"sourceBalanceAge\">Balance cached for up to 5 minutes</p></div><div><span class=\"label\">Last observed migration</span><strong id=\"lastMigrationAge\">—</strong><p class=\"muted\" id=\"lastMigrationNote\">Within the tracking period · not the last account operation</p></div></div></section>\n<section class=\"stats\" aria-label=\"Confirmed migrations\">\n<article class=\"card\"><span class=\"label\">1st migration · confirmed wallets</span><strong class=\"value\" id=\"first\">—</strong><div class=\"migration-volume\"><strong id=\"firstPi\">—</strong><span>Pi received · cumulative</span></div><p class=\"muted\">Cumulative since tracking started</p></article>\n<article class=\"card second\"><span class=\"label\">2nd migration · confirmed wallets</span><strong class=\"value\" id=\"second\">—</strong><div class=\"migration-volume\"><strong id=\"secondPi\">—</strong><span>Pi received · cumulative</span></div><p class=\"muted\">Cumulative since tracking started</p></article>\n</section>\n<div class=\"status\" role=\"status\"><p class=\"muted\" id=\"freshness\">Checking collector status…</p><p class=\"muted\" id=\"pending\">Unverified receipts are not included in the confirmed counters.</p></div>\n<section class=\"ranking\"><div class=\"heading\"><h2>Top 20 · Pi received</h2><p class=\"muted\">Last 7 days · all migration lockups combined per wallet</p><p class=\"muted\" id=\"rankingStatus\">Waiting for observed receipts</p></div>\n<div class=\"table-wrap\"><table><thead><tr><th>Rank</th><th>Wallet</th><th>Migration</th><th class=\"amount\">Pi received</th></tr></thead><tbody id=\"rows\"></tbody></table></div><div class=\"empty\" id=\"empty\">No receipts recorded in this tracking period yet.</div></section>\n<section class=\"historical\" aria-label=\"Historical second migrations\"><div class=\"historical-header\"><h2>Historical 2nd migrations</h2><span id=\"historyHealth\" class=\"chip warn\">Waiting</span></div><p class=\"muted\">Since February 1, 2026 · separate historical recovery</p><div class=\"historical-grid\"><div><span class=\"label\">Confirmed wallets</span><strong id=\"historyWallets\">—</strong></div><div><span class=\"label\">Pi received · cumulative</span><strong id=\"historyPi\">—</strong></div></div><p class=\"muted\" id=\"historyProgress\">Waiting for the historical collector's first scheduled run.</p><p class=\"muted\" id=\"historyPending\">Partial results until source scanning and classification catch up.</p><p class=\"muted\" id=\"historyUpdated\"></p><details><summary>Historical coverage</summary><p>Only confirmed second migrations from the migration wallet displayed above are included. The scan starts on February 1, 2026; earlier recipient history is checked when needed. This date defines the search period, not an official launch date.</p><p>This overlaps with the live monitoring period: do not add these totals to the counters above. Catching up with the available API history does not establish coverage of other migration source wallets or missing records. Recovery has its own budget and continues from its saved position.</p></details></section>\n<details><summary>What these numbers mean</summary><p>The two counters include unique wallets with a confirmed first or second migration received after tracking started. They do not represent every migration ever made on Pi Network. They accumulate over time and do not reset after seven days. The Pi amounts combine all recorded lockups of each confirmed migration in the same tracking period. Pending receipts are added only after classification; unlocking or spending Pi does not reduce these totals.</p><p>The Top 20 includes observed migration receipts, including those awaiting classification. Its seven-day coverage builds from the tracking start. A wallet can appear in both confirmed counters if it receives both migrations during this period. Later migrations can appear in the Top 20 but do not add to these two counters.</p><p>A migration groups the lockups for the same wallet and transaction. Account history is consulted only when needed to establish its migration number, and verified evidence is saved. No second migration is assumed from the age of an account.</p></details>\n<footer>Independent on-chain monitor · amounts abbreviated with K/M · v41</footer>\n</main><script>\nconst $=id=>document.getElementById(id);const full=n=>Number(n).toLocaleString('en-US',{maximumFractionDigits:7});const compact=n=>Number(n)>=1000?new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:2}).format(Number(n)):full(n);const date=s=>new Date(s).toLocaleString('en-US');let loading=false,lastSignature='';\nlet sourceInfo=null,lastMigrationAt=null;\nfunction relativeAge(at,now=Date.now()){\n if(!at||!Number.isFinite(Date.parse(at)))return 'Not observed yet';\n const minutes=Math.floor(Math.max(0,now-Date.parse(at))/60000);\n if(minutes<1)return 'Less than a minute ago';\n if(minutes<60)return minutes+' minute'+(minutes===1?'':'s')+' ago';\n const hours=Math.floor(minutes/60);if(hours<24)return hours+' hour'+(hours===1?'':'s')+' ago';\n const days=Math.floor(hours/24);return days+' day'+(days===1?'':'s')+' ago';\n}\nfunction sourceAges(){\n $('lastMigrationAge').textContent=relativeAge(lastMigrationAt);$('lastMigrationAge').title=lastMigrationAt?date(lastMigrationAt):'No migration observed since tracking started';\n $('sourceBalanceAge').textContent=(sourceInfo?.checkedAt?'Checked '+relativeAge(sourceInfo.checkedAt).toLowerCase()+' · 5-minute cache':'Balance not available yet')+(sourceInfo?.error?' · balance update delayed':'');\n}\n$('sourceCopy').onclick=async()=>{try{await navigator.clipboard.writeText($('sourceAddress').textContent);$('sourceCopy').textContent='Copied';setTimeout(()=>$('sourceCopy').textContent='Copy',1500);}catch{$('sourceCopy').textContent='Copy failed';}};\nsetInterval(sourceAges,15000);\nfunction number(id,value){$(id).textContent=compact(value);$(id).title=full(value);$(id).setAttribute('aria-label',full(value));}\nfunction ranking(data){\n if(!data)return;\n $('rankingStatus').textContent=(data.complete?'Full seven-day coverage':'Partial seven-day coverage · since tracking started')+(data.updatedAt?' · updated '+date(data.updatedAt):'')+(data.error?' · update delayed':'');\n const rows=data.rows||[],signature=JSON.stringify(rows);if(signature===lastSignature)return;lastSignature=signature;\n $('rows').replaceChildren();$('empty').hidden=rows.length>0;\n for(const row of rows){const tr=document.createElement('tr');const rank=tr.insertCell();rank.textContent='#'+row.rank;\n  const wallet=tr.insertCell();const wrap=document.createElement('div');wrap.className='wallet';const a=document.createElement('a');a.textContent=row.address.slice(0,8)+'…'+row.address.slice(-6);a.title=row.address;a.href='https://blockexplorer.minepi.com/mainnet/accounts/'+encodeURIComponent(row.address);a.target='_blank';a.rel='noopener';wrap.append(a);\n  const button=document.createElement('button');button.className='copy';button.textContent='Copy';button.setAttribute('aria-label','Copy wallet '+row.address);button.onclick=async()=>{try{await navigator.clipboard.writeText(row.address);button.textContent='Copied';setTimeout(()=>button.textContent='Copy',1500);}catch{button.textContent='Copy failed';}};wrap.append(button);wallet.append(wrap);\n  const type=tr.insertCell();type.className='type';type.textContent=row.type;const amount=tr.insertCell();amount.className='amount';amount.textContent=compact(row.amountPi)+' Pi';amount.title=row.amountPi+' Pi';$('rows').append(tr);\n }\n}\nasync function refresh(){if(loading||document.hidden)return;loading=true;try{\n const response=await fetch('/live',{cache:'no-store',signal:AbortSignal.timeout(10000)});const data=await response.json();if(!response.ok)throw new Error(data.error||'Collector unavailable');if(![36,37,38,39,40,41].includes(data.version))throw new Error('Publish the current Worker to activate the simplified monitor');\n sourceInfo=data.sourceAccount||null;lastMigrationAt=data.lastMigrationAt||null;sourceAges();\n $('sourceBalance').textContent=sourceInfo?.balance!=null?compact(sourceInfo.balance)+' Pi':'—';$('sourceBalance').title=sourceInfo?.balance!=null?sourceInfo.balance+' Pi':'Balance unavailable';\n for(const key of ['first','second']){const value=data.volumes?.[key+'Pi'];$(key+'Pi').textContent=value!=null?compact(value)+' Pi':'—';$(key+'Pi').title=value!=null?value+' Pi · confirmed migrations since tracking started':'Awaiting accumulated amounts';}\n $('period').textContent=data.startedAt?'Tracking since '+date(data.startedAt):'Tracking starts on the first scheduled collection';\n if(data.counts){number('first',data.counts.first);number('second',data.counts.second);$('pending').textContent=full(data.counts.pending)+' receipts awaiting classification'+(data.historyError?' · historical verification delayed':'');}\n const delayed=!!data.error||!data.checkedAt||Date.now()-Date.parse(data.checkedAt)>180000;\n $('health').textContent=delayed?'Delayed':data.backlog?'Catching up':'Collector online';$('health').className='chip'+(delayed||data.backlog?' warn':'');\n $('freshness').textContent=(data.checkedAt?'Last successful collection: '+date(data.checkedAt):'Waiting for the first scheduled collection')+(data.error?' · '+data.error:'')+(data.backlog?' · New receipts are queued.':'');ranking(data.ranking);\n}catch(error){$('health').textContent='Unavailable';$('health').className='chip warn';$('freshness').textContent=error.message+' · Previously displayed numbers may be stale.';}finally{loading=false;}}\nlet historyLoading=false;\nasync function refreshHistorical(){\n if(historyLoading||document.hidden)return;historyLoading=true;\n try{\n  const response=await fetch('/historical',{cache:'no-store',signal:AbortSignal.timeout(10000)});const data=await response.json();\n  if(!response.ok)throw new Error(data.error||'Historical collector unavailable');\n  const h=data.historical||{},pending=data.counts?.pending;\n  if(data.counts)number('historyWallets',data.counts.second);\n  if(data.volumes){$('historyPi').textContent=compact(data.volumes.secondPi)+' Pi';$('historyPi').title=data.volumes.secondPi+' Pi';}\n  const stale=data.checkedAt&&Date.now()-Date.parse(data.checkedAt)>15*60000;\n  const complete=h.sourceComplete&&pending===0&&!data.error&&!data.historyError&&!stale;\n  $('historyHealth').textContent=data.error||stale?'Delayed':h.initializing?'Preparing':complete?'Caught up':'Partial';\n  $('historyHealth').className='chip'+(complete?'':' warn');\n  $('historyProgress').textContent=h.initializing?'Locating the February 2026 starting point; progress is saved between runs.':(h.scannedThrough?'Source scanned through '+date(h.scannedThrough):'Source scan is starting')+(h.targetAt?' · target '+date(h.targetAt):'');\n  $('historyPending').textContent=(pending!=null?full(pending)+' historical receipts awaiting classification':'Awaiting historical receipts')+(h.sourceComplete?' · source scan caught up to the displayed target':' · source scan incomplete');\n  $('historyUpdated').textContent=(data.checkedAt?'Last collection: '+date(data.checkedAt):'Runs every 5 minutes')+(data.error?' · '+data.error:'')+(data.historyError?' · '+data.historyError:'');\n }catch(error){$('historyHealth').textContent='Unavailable';$('historyHealth').className='chip warn';$('historyUpdated').textContent=error.message+' · Previously displayed numbers may be stale.';}finally{historyLoading=false;}\n}\nrefreshHistorical();setInterval(refreshHistorical,60000);\nrefresh();setInterval(refresh,20000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});\n</script></body></html>\n";
function json(value,status=200){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});}
export default {
 async scheduled(event,env,ctx){ctx.waitUntil(event.cron==='*/5 * * * *'?collectHistorical(env):collectFocus(env));},
 async fetch(request,env){
  const path=new URL(request.url).pathname;
  if(path==='/historical'){
   if(request.method!=='GET')return json({error:'Method not allowed'},405);
   try{const row=await env.DB.prepare('SELECT snapshot FROM historical_control WHERE id=1').first();return json(row?.snapshot?JSON.parse(row.snapshot):{historical:{since:HISTORICAL_SINCE,initializing:true},counts:null});}catch(e){if(String(e.message).includes('no such table'))return json({historical:{since:HISTORICAL_SINCE,initializing:true},counts:null});return json({error:'Historical data unavailable: '+e.message},503);}
  }
  if(path==='/live'){
   if(request.method!=='GET')return json({error:'Method not allowed'},405);
   try{const row=await env.DB.prepare('SELECT snapshot FROM focus_control WHERE id=1').first();return json(row?.snapshot?JSON.parse(row.snapshot):{version:41,startedAt:null,counts:null,error:'Waiting for first scheduled collection'});}catch{return json({error:'Collector not initialized; check DB binding and Cron Trigger'},503);}
  }
  if(path==='/stats'||path.startsWith('/d1/')||path==='/wallet-balances'||path.startsWith('/horizon/'))return json({error:'Legacy analytics disabled in v36. Use /live.'},410);
  if(path==='/'&&request.method==='GET')return new Response(PAGE,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
  return json({error:'Not found'},404);
 }
};
