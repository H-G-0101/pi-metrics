// Generated v45: focused migration collector and cached source balance.
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
// Bounded hourly telemetry, persisted in the same atomic commits as receipts.
function queueMetrics(telemetry,pending,blocked=false,now=Date.now()){
  const start=Number(telemetry?.since||now),elapsed=Math.max(0,now-start);
  const buckets=(telemetry?.buckets||[]).filter(b=>b.at>now-3600000&&b.at<=now);
  const resolved=buckets.reduce((n,b)=>n+b.resolved,0),added=buckets.reduce((n,b)=>n+b.added,0);
  const ready=elapsed>=3600000,net=resolved-added;
  return {updatedAt:new Date(now).toISOString(),observedMinutes:Math.min(60,Math.floor(elapsed/60000)),ready,resolved,added,net,pending,
    trend:net>0?'shrinking':net<0?'growing':'stable',
    etaHours:ready&&!blocked&&pending>0&&net>0?pending/net:null,blocked};
}
function migrationProof(proof){
  if(!proof)return [];
  const events=proof.policyVersion===29&&proof.genesis&&!proof.ambiguous?(proof.events||[]).slice(0,2).map((e,i)=>({...e,round:i+1})):[];
  if(!events.length&&proof.birthHash)events.push({hash:proof.birthHash,round:1,at:null});
  return events.filter(e=>/^[a-f0-9]{64}$/i.test(e.hash));
}
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
  state.telemetry||={since:now,buckets:[]};
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
    const minute=Math.floor(Date.now()/60000)*60000;
    next.telemetry={since:state.telemetry.since,buckets:state.telemetry.buckets.filter(b=>b.at>minute-3600000).map(b=>({...b}))};
    let bucket=next.telemetry.buckets.find(b=>b.at===minute);
    if(!bucket){bucket={at:minute,added:0,resolved:0};next.telemetry.buckets.push(bucket);}
    for(const address of addresses){
      const before=previous.filter(e=>e.address===address),after=events.filter(e=>e.address===address),proof=evidence.get(address);
      for(const event of after){
        event.round=focusRound(proof,event.hash);
        const old=before.find(e=>e.hash===event.hash);
        if(event.round==null&&(!old||old.round!=null))bucket.added++;
        if(old&&old.round==null&&event.round!=null)bucket.resolved++;
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
        const proofs=new Map(((await DB.prepare('SELECT address,evidence FROM focus_wallets WHERE address IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(rows.map(r=>r.address))).all()).results||[]).map(w=>[w.address,migrationProof(JSON.parse(w.evidence))]));
        ranking={updatedAt:new Date().toISOString(),complete:state.startedAt<=from&&!state.backlog&&!error,rows:rows.map((r,i)=>({rank:i+1,address:r.address,evidence:proofs.get(r.address)||[],amountPi:decimal(r.units),type:[r.first?'1st':null,r.second?'2nd':null,r.later?'Later':null,r.pending?'Pending':null].filter(Boolean).join(' / ')}))};
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
    const queue=queueMetrics(state.telemetry,state.counts?.pending||0,!!error||!!historyError||!!state.backlog||state.writes>=limit||state.historyWrites>=historyLimit||Number(state.historyPauseUntil||0)>Date.now());
    const snapshot={version:45,updatedAt:new Date().toISOString(),queue,historical,volumes,sourceAccount,lastMigrationAt:state.lastMigrationAt||null,lastMigrationHash:state.lastMigrationHash||null,startedAt:state.startedAt||null,checkedAt:state.checkedAt||null,counts:state.counts||null,backlog:!!state.backlog,error,historyError,ranking};
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
  return {prepare:sql=>DB.prepare(sql.replace(/\bfocus_/g,'historical2026_')),batch:statements=>DB.batch(statements)};
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

const PAGE="<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><meta name=\"theme-color\" content=\"#0b1018\"><title>Pi Metrics · Migration Monitor</title><style>\n:root{color-scheme:dark;--bg:#0b1018;--panel:#131b28;--edge:#2a3647;--muted:#a1aec1;--ink:#edf2fa;--purple:#b3a5ff;--green:#65dcba;--blue:#8dbbff}\n*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif}a{color:inherit}button,a,summary{touch-action:manipulation}:focus-visible{outline:2px solid var(--blue);outline-offset:4px}main{max-width:1200px;margin:auto;padding:0 32px 32px}.topbar{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:23px 0;border-bottom:1px solid var(--edge)}.brand{display:flex;align-items:center;gap:12px;font-weight:700;letter-spacing:.02em}.brand-mark{display:grid;place-items:center;width:34px;height:34px;background:#282644;border:1px solid #524a7e;border-radius:9px;font-size:24px;color:var(--purple)}.network{font-size:11px;letter-spacing:.13em;color:var(--muted);text-transform:uppercase}.network:before{content:'';display:inline-block;width:6px;height:6px;background:var(--green);border-radius:50%;margin-right:9px}nav{display:flex;gap:24px;font-size:13px;color:var(--muted)}nav a{text-decoration:none}nav a:hover{color:var(--ink)}header{padding:40px 0 30px;display:flex;align-items:center;justify-content:space-between;gap:20px}h1{font-size:clamp(28px,4vw,40px);font-weight:650;letter-spacing:-1.5px;line-height:1.2;margin:8px 0 12px}h2{font-size:20px;font-weight:650;letter-spacing:-.4px;margin:0}h3{font-size:15px;font-weight:600;margin:0}.eyebrow{color:var(--muted);font-size:10px;font-weight:650;letter-spacing:.16em;text-transform:uppercase}.muted{color:var(--muted);font-size:13px;margin:5px 0}.chip{border:1px solid #2c584b;border-radius:7px;padding:6px 11px;color:var(--green);background:#162b27;font-size:11px;font-weight:600;white-space:nowrap}.chip.warn{color:#eac785;background:#2a251c;border-color:#51432b}.section-title{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:0 0 15px}.section-title p{margin:0}.period-note{font-size:12px;color:var(--muted)}section[id]{scroll-margin-top:20px}.stats{display:grid;grid-template-columns:1fr 1fr;gap:20px}.card{background:var(--panel);border:1px solid var(--edge);border-radius:14px;padding:25px 28px;position:relative}.card:before{content:'';position:absolute;left:28px;right:28px;top:0;height:2px;background:var(--purple)}.card.second:before{background:var(--green)}.card-head{display:flex;align-items:center;justify-content:space-between}.ordinal{font-size:11px;padding:3px 8px;border:1px solid #49415e;border-radius:5px;color:var(--purple)}.second .ordinal{border-color:#2e554a;color:var(--green)}.card-period{font-size:12px;color:var(--muted);margin:5px 0 0}.value{display:block;font-size:clamp(40px,5vw,58px);line-height:1.15;letter-spacing:-2px;font-weight:650;font-variant-numeric:tabular-nums;margin:22px 0 3px}.value-caption{color:var(--muted);font-size:12px}.migration-volume{margin-top:22px;padding-top:16px;border-top:1px solid var(--edge);display:flex;align-items:center;justify-content:space-between;gap:12px}.migration-volume strong{font-size:23px;color:var(--purple);font-variant-numeric:tabular-nums}.second .migration-volume strong{color:var(--green)}.migration-volume span{color:var(--muted);font-size:12px}.card-foot{font-size:11px;color:var(--muted);margin:5px 0 0}.status{padding:17px 0 28px;display:grid;gap:4px}.status p{margin:0}.pending-help{font-size:11px;color:var(--muted)}.historical{padding:26px 28px;background:#121e2e;border:1px solid #344c69;border-radius:14px;margin:8px 0 32px}.historical-header{display:flex;align-items:center;justify-content:space-between;gap:16px}.historical h2{color:#e2edff}.historical-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin:22px 0}.historical-grid strong{display:block;color:var(--blue);font-size:36px;line-height:1.3;font-weight:650;letter-spacing:-1px;font-variant-numeric:tabular-nums;margin:3px 0}.label{font-size:12px;color:var(--muted)}.overlap-note{color:#c0d5ef;background:#192c43;border:1px solid #2e4764;padding:10px 13px;border-radius:7px;font-size:12px;margin:18px 0}.coverage{border-top:1px solid #314159;padding-top:15px}.coverage p{margin:5px 0}.ranking{border:1px solid var(--edge);border-radius:14px;background:var(--panel);overflow:hidden;margin-bottom:30px}.heading{padding:24px 28px}.heading p{margin:5px 0}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:13px}th{font-size:10px;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);text-align:left;background:#101825;padding:13px 22px;border-top:1px solid var(--edge)}td{padding:17px 22px;border-top:1px solid #283344}tbody tr:nth-child(odd){background:#182231}tbody tr:nth-child(even){background:#121b28}tbody tr:hover{background:#202d40}td:first-child{color:var(--muted);font-variant-numeric:tabular-nums}.amount{text-align:right;font-weight:600;white-space:nowrap;font-variant-numeric:tabular-nums}.wallet{display:flex;align-items:center;gap:12px;white-space:nowrap}.wallet a{text-decoration:none;font:12px ui-monospace,monospace}.wallet a:hover{text-decoration:underline}.copy{background:#202d3f;color:#d1dceb;border:1px solid #3b4b62;border-radius:6px;padding:5px 9px;font:11px system-ui;cursor:pointer}.copy:hover{background:#31425b}.type{font-size:12px;color:var(--green);max-width:250px}.type.pending-type{color:#eac785}.empty{padding:32px;text-align:center;color:var(--muted);font-size:13px}.source{border:1px solid var(--edge);border-radius:14px;padding:24px 28px;background:#101824}.source-address{display:flex;align-items:center;gap:14px;margin:9px 0 22px}.source-address a{min-width:0;overflow-wrap:anywhere;font:12px/1.7 ui-monospace,monospace;text-decoration:none}.source-address .copy{flex-shrink:0}.source-metrics{display:grid;grid-template-columns:1fr 1fr;gap:24px;border-top:1px solid var(--edge);padding-top:16px}.source-metrics strong{display:block;font-size:22px;font-weight:550;margin:3px 0}.source-metrics p{font-size:11px}details{font-size:12px;color:var(--muted);margin-top:18px}summary{cursor:pointer;color:#c5d1e2}details p{max-width:90ch}.methodology{border-top:1px solid var(--edge);padding-top:20px;margin-top:28px}.method-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;margin:20px 0}.method-grid strong{color:var(--ink);font-size:12px}.method-grid p{margin:5px 0}footer{display:flex;justify-content:space-between;gap:16px;padding-top:26px;font-size:11px;color:var(--muted)}\n@media(max-width:680px){main{padding:0 18px 25px}nav{gap:14px;font-size:12px}.network{display:none}header{padding:28px 0;align-items:flex-start}.chip{font-size:10px}h1{letter-spacing:-.8px}.section-title{align-items:flex-start;flex-direction:column;gap:3px}.stats{grid-template-columns:1fr;gap:16px}.card{padding:22px}.value{font-size:48px;margin-top:18px}.historical{padding:22px 18px}.historical-header{align-items:flex-start}.historical-header h2{font-size:18px}.historical-grid{gap:14px}.historical-grid strong{font-size:28px}.heading,.source{padding:20px 18px}.source-metrics{grid-template-columns:1fr;gap:16px}.source-address{gap:10px}th,td{padding:14px 15px}.method-grid{grid-template-columns:1fr;gap:12px}footer{flex-direction:column;gap:3px}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}\n.queue-panel{border:1px solid var(--edge);border-radius:10px;padding:18px 20px;margin:0 0 26px;background:#101824}.queue-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin:12px 0}.queue-grid strong{display:block;font-size:20px;font-variant-numeric:tabular-nums}.queue-grid span{font-size:11px;color:var(--muted)}.queue-panel p{font-size:12px;color:var(--muted);margin:6px 0}.update-age{font-size:11px;color:var(--muted);margin-top:10px}.proof{margin:0}.proof summary{color:var(--green)}.proof a{display:block;color:var(--blue);font-size:11px;margin-top:8px}.proof p{font-size:11px}.progress-track{width:100%;height:8px;accent-color:var(--blue);display:block;margin:12px 0}.progress-label{font-size:12px;color:var(--muted)}@media(max-width:680px){.queue-grid{grid-template-columns:1fr;gap:12px}.queue-grid strong{font-size:18px}}</style></head><body><main><div class=\"topbar\"><div class=\"brand\"><span class=\"brand-mark\" aria-hidden=\"true\">π</span>Pi Metrics<span class=\"network\">Mainnet</span></div><nav aria-label=\"Dashboard sections\"><a href=\"#overview\">Overview</a><a href=\"#history\">History</a><a href=\"#ranking\">Top 20</a></nav></div>\n<header><div><span class=\"eyebrow\">Independent on-chain analytics</span><h1>Migration monitor</h1><p class=\"muted\">Confirmed migration activity, with clear periods and verifiable coverage.</p></div><span id=\"health\" class=\"chip warn\">Connecting</span></header>\n<section id=\"overview\" aria-label=\"Tracking period overview\"><div class=\"section-title\"><h2>Tracking overview</h2><p class=\"period-note\" id=\"period\">Waiting for collection to start</p></div><div class=\"stats\"><article class=\"card \"><div class=\"card-head\"><h3>First migration</h3><span class=\"ordinal\">01</span></div><p class=\"card-period\" id=\"firstPeriod\">Start date pending</p><strong class=\"value\" id=\"first\">—</strong><span class=\"value-caption\">Unique wallets · confirmed</span><div class=\"migration-volume\"><span>Total Pi migrated</span><strong id=\"firstPi\">—</strong></div><p class=\"card-foot\">Cumulative · includes locked Pi</p></article><article class=\"card second\"><div class=\"card-head\"><h3>Second migration</h3><span class=\"ordinal\">02</span></div><p class=\"card-period\" id=\"secondPeriod\">Start date pending</p><strong class=\"value\" id=\"second\">—</strong><span class=\"value-caption\">Unique wallets · confirmed</span><div class=\"migration-volume\"><span>Total Pi migrated</span><strong id=\"secondPi\">—</strong></div><p class=\"card-foot\">Cumulative · includes locked Pi</p></article></div></section>\n<p class=\"update-age\" id=\"overviewAge\">Counters: waiting for an update</p><div class=\"status\" role=\"status\"><p class=\"muted\" id=\"freshness\">Checking collection status…</p><p class=\"muted\" id=\"pending\">Waiting for classification status.</p><span class=\"pending-help\">Awaiting classification means Pi was received, but its migration number is not yet confirmed.</span></div>\n<section class=\"queue-panel\" aria-label=\"Classification queue\"><h3>Classification pace</h3><div class=\"queue-grid\"><div><strong id=\"queueResolved\">—</strong><span>Pending receipts classified · last hour</span></div><div><strong id=\"queueAdded\">—</strong><span>Receipts added to the queue · last hour</span></div><div><strong id=\"queueTrend\">Measuring</strong><span>Queue trend · includes incoming receipts</span></div></div><p id=\"queueEta\">Estimating requires one hour of observations.</p><p id=\"queueAge\"></p><details><summary>How this estimate works</summary><p>Estimated time equals the current pending queue divided by its net hourly reduction. It assumes the recent pace continues. New receipts, API limits and harder histories can change the result. This is not a completion deadline.</p></details></section><section class=\"historical\" id=\"history\" aria-label=\"Historical second migrations\"><div class=\"historical-header\"><div><span class=\"eyebrow\">Extended period</span><h2>Second migrations · historical coverage</h2><p class=\"muted\">Since February 1, 2026 · UTC</p></div><span id=\"historyHealth\" class=\"chip warn\">Waiting</span></div><div class=\"historical-grid\"><div><span class=\"label\">Unique wallets · confirmed</span><strong id=\"historyWallets\">—</strong></div><div><span class=\"label\">Total Pi migrated</span><strong id=\"historyPi\">—</strong><span class=\"label\">Cumulative · includes locked Pi</span></div></div><div class=\"overlap-note\"><strong>Overlapping periods — do not add totals.</strong> The historical search overlaps the tracking period above; collection may still be incomplete.</div><div class=\"coverage\"><label class=\"progress-label\" id=\"historyBarLabel\" for=\"historyBar\">Date coverage · waiting for collection</label><progress class=\"progress-track\" id=\"historyBar\" max=\"100\" value=\"0\"></progress><p class=\"muted\">This bar measures the date range scanned, not classification completion or time remaining.</p><p class=\"muted\" id=\"historyProgress\">Collection coverage: waiting for the first historical run.</p><p class=\"muted\" id=\"historyPending\">Classification: waiting for received events.</p><p class=\"muted\" id=\"historyUpdated\"></p><p class=\"muted\" id=\"historyErrors\"></p><p class=\"muted\" id=\"historyPace\">Classification pace: measuring</p></div><details><summary>About this historical period</summary><p>February 1, 2026 is the start of this search, not an official launch date. Counts cover only confirmed second migration events from the source wallet displayed below.</p><p>Collected history and classification are separate steps. Results remain partial until both catch up. Coverage depends on records available from the API and does not include other source wallets.</p></details></section>\n<section class=\"ranking\" id=\"ranking\"><div class=\"heading\"><span class=\"eyebrow\">Rolling 7-day window</span><h2>Top 20 migration recipients</h2><p class=\"muted\">Ranked by total Pi migrated to each wallet · all lockups combined</p><p class=\"muted\" id=\"rankingStatus\">Waiting for observed receipts</p></div><div class=\"table-wrap\"><table><thead><tr><th scope=\"col\">Rank</th><th scope=\"col\">Wallet</th><th scope=\"col\">Classification</th><th scope=\"col\" class=\"amount\">Pi migrated</th></tr></thead><tbody id=\"rows\"></tbody></table></div><div class=\"empty\" id=\"empty\">No receipts recorded in this tracking period yet.</div></section>\n<section class=\"source\" aria-label=\"Migration source wallet\"><span class=\"label\">Migration source wallet</span><div class=\"source-address\"><a id=\"sourceAddress\" href=\"https://blockexplorer.minepi.com/mainnet/accounts/GABT7EMPGNCQSZM22DIYC4FNKHUVJTXITUF6Y5HNIWPU4GA7BHT4GC5G\" target=\"_blank\" rel=\"noopener\">GABT7EMPGNCQSZM22DIYC4FNKHUVJTXITUF6Y5HNIWPU4GA7BHT4GC5G</a><button id=\"sourceCopy\" class=\"copy\" aria-label=\"Copy migration source wallet\">Copy</button></div><div class=\"source-metrics\"><div><span class=\"label\">Source wallet balance</span><strong id=\"sourceBalance\">—</strong><p class=\"muted\" id=\"sourceBalanceAge\">Updated every 5 minutes</p></div><div><span class=\"label\">Last observed migration</span><strong id=\"lastMigrationAge\">—</strong><p class=\"muted\" id=\"lastMigrationNote\">Latest migration observed during live tracking</p></div></div></section>\n<details class=\"methodology\"><summary>How to read these numbers</summary><div class=\"method-grid\"><div><strong>Wallets, not people</strong><p>Counts represent unique wallet addresses. A person may control more than one wallet. A wallet can appear in both migration counters.</p></div><div><strong>Migrated Pi, not current balance</strong><p>Totals combine recorded lockups for confirmed events in the stated period. Claims and spending do not reduce these totals.</p></div><div><strong>Received, then classified</strong><p>A receipt groups lockups for one wallet and transaction. Pending receipts may appear in the Top 20, but enter confirmed totals only after verification.</p></div></div><p>Migration numbers are established from available on-chain evidence. They do not reveal a user's identity, mining-app balance or eligibility. The overview accumulates since tracking started; only the Top 20 uses a rolling seven-day window.</p></details>\n<footer><span>Pi Metrics · Independent monitor · Not affiliated with Pi Network</span><span>Dates in UTC · K = thousand · M = million · v45</span></footer></main><script>\nconst $=id=>document.getElementById(id);const full=n=>Number(n).toLocaleString('en-US',{maximumFractionDigits:7});const compact=n=>Number(n)>=1000?new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:2}).format(Number(n)):full(n);const date=s=>new Date(s).toLocaleString('en-US',{timeZone:'UTC'})+' UTC';let loading=false,lastSignature='';\nlet sourceInfo=null,lastMigrationAt=null;\nlet liveUpdated=null,rankingUpdated=null,historyUpdated=null,queueData=null,historyQueue=null,rankingInfo=null;\nfunction duration(hours){return hours<1?Math.max(1,Math.ceil(hours*60))+' minutes':hours<48?Math.ceil(hours)+' hours':Math.ceil(hours/24)+' days';}\nfunction queueView(q,stale=false){\n if(!q)return {pace:'Measuring',eta:'Estimating requires one hour of observations.'};\n const pace=(q.ready?'Last hour':q.observedMinutes+' minutes observed')+': '+full(q.resolved)+' classified · '+full(q.added)+' queued';\n let eta=q.pending===0?'No receipts awaiting classification.':!q.ready?'Learning the pace · '+q.observedMinutes+'/60 minutes observed.':q.blocked||stale?'Estimate paused while collection or classification is delayed.':q.etaHours!=null?'Estimated queue clearance: about '+duration(q.etaHours)+', if the current pace continues.':q.net<=0?'No reliable clearance estimate: the queue is stable or growing.':'No pending queue to estimate.';\n return {pace,eta};\n}\nfunction sectionAges(){\n const age=(id,at,prefix)=>{$(id).textContent=prefix+(at?relativeAge(at):'waiting for an update');$(id).title=at?date(at):'';};\n age('overviewAge',liveUpdated,'Counters updated: ');age('queueAge',queueData?.updatedAt,'Queue measured: ');\n if(rankingInfo){$('rankingStatus').textContent=(rankingInfo.complete?'Full seven-day coverage':'Partial seven-day coverage · since tracking started')+(rankingUpdated?' · updated '+relativeAge(rankingUpdated):'')+(rankingInfo.error?' · update delayed':'');$('rankingStatus').title=rankingUpdated?date(rankingUpdated):'';}\n if(historyQueue){const v=queueView(historyQueue,Date.now()-Date.parse(historyQueue.updatedAt)>900000);$('historyPace').textContent=v.pace+' · '+v.eta;}\n if(historyUpdated)$('historyUpdated').textContent='Last collection: '+relativeAge(historyUpdated)+' · '+date(historyUpdated);\n if(queueData){const stale=Date.now()-Date.parse(queueData.updatedAt)>180000;const v=queueView(queueData,stale);$('queueEta').textContent=v.eta;}\n}\n\nfunction relativeAge(at,now=Date.now()){\n if(!at||!Number.isFinite(Date.parse(at)))return 'Not observed yet';\n const minutes=Math.floor(Math.max(0,now-Date.parse(at))/60000);\n if(minutes<1)return 'Less than a minute ago';\n if(minutes<60)return minutes+' minute'+(minutes===1?'':'s')+' ago';\n const hours=Math.floor(minutes/60);if(hours<24)return hours+' hour'+(hours===1?'':'s')+' ago';\n const days=Math.floor(hours/24);return days+' day'+(days===1?'':'s')+' ago';\n}\nfunction sourceAges(){\n $('lastMigrationAge').textContent=relativeAge(lastMigrationAt);$('lastMigrationAge').title=lastMigrationAt?date(lastMigrationAt):'No migration observed since tracking started';\n $('sourceBalanceAge').textContent=(sourceInfo?.checkedAt?'Checked '+relativeAge(sourceInfo.checkedAt).toLowerCase()+' · updated every 5 minutes':'Balance not available yet')+(sourceInfo?.error?' · balance update delayed':'');\n}\n$('sourceCopy').onclick=async()=>{try{await navigator.clipboard.writeText($('sourceAddress').textContent);$('sourceCopy').textContent='Copied';setTimeout(()=>$('sourceCopy').textContent='Copy',1500);}catch{$('sourceCopy').textContent='Copy failed';}};\nsetInterval(()=>{sourceAges();sectionAges();},15000);\nfunction number(id,value){$(id).textContent=compact(value);$(id).title=full(value);$(id).setAttribute('aria-label',full(value));}\nfunction ranking(data){\n if(!data)return;\n rankingInfo=data;rankingUpdated=data.updatedAt||null;\n $('rankingStatus').textContent=(data.complete?'Full seven-day coverage':'Partial seven-day coverage · since tracking started')+(data.updatedAt?' · updated '+relativeAge(data.updatedAt):'')+(data.error?' · update delayed':'');\n const rows=data.rows||[],signature=JSON.stringify(rows);if(signature===lastSignature)return;lastSignature=signature;\n $('rows').replaceChildren();$('empty').hidden=rows.length>0;\n for(const row of rows){const tr=document.createElement('tr');const rank=tr.insertCell();rank.textContent='#'+row.rank;\n  const wallet=tr.insertCell();const wrap=document.createElement('div');wrap.className='wallet';const a=document.createElement('a');a.textContent=row.address.slice(0,8)+'…'+row.address.slice(-6);a.title=row.address;a.href='https://blockexplorer.minepi.com/mainnet/accounts/'+encodeURIComponent(row.address);a.target='_blank';a.rel='noopener';wrap.append(a);\n  const button=document.createElement('button');button.className='copy';button.textContent='Copy';button.setAttribute('aria-label','Copy wallet '+row.address);button.onclick=async()=>{try{await navigator.clipboard.writeText(row.address);button.textContent='Copied';setTimeout(()=>button.textContent='Copy',1500);}catch{button.textContent='Copy failed';}};wrap.append(button);wallet.append(wrap);\n  const type=tr.insertCell();type.className='type'+(String(row.type||'Pending').includes('Pending')?' pending-type':'');type.textContent=String(row.type||'Pending').replaceAll('Pending','Received · awaiting classification').replaceAll('Later','Later event detected');if(row.evidence?.length){const details=document.createElement('details');details.className='proof';const summary=document.createElement('summary');summary.textContent=type.textContent+' · evidence';details.append(summary);const note=document.createElement('p');note.textContent='Migration history for this recipient. Transaction batches may contain other recipients.';details.append(note);for(const e of row.evidence){if(!/^[a-f0-9]{64}$/i.test(e.hash))continue;const link=document.createElement('a');link.href='https://blockexplorer.minepi.com/mainnet/transactions/'+encodeURIComponent(e.hash);link.target='_blank';link.rel='noopener';link.textContent=(e.round===1?'First':'Second')+' migration · '+(e.at?date(e.at):'account-creation transaction');link.title=e.hash;details.append(link);}type.textContent='';type.append(details);}const amount=tr.insertCell();amount.className='amount';amount.textContent=compact(row.amountPi)+' Pi';amount.title=row.amountPi+' Pi';$('rows').append(tr);\n }\n}\nasync function refresh(){if(loading||document.hidden)return;loading=true;try{\n const response=await fetch('/live',{cache:'no-store',signal:AbortSignal.timeout(10000)});const data=await response.json();if(!response.ok)throw new Error(data.error||'Collector unavailable');if(![36,37,38,39,40,41,42,43,44,45].includes(data.version))throw new Error('Publish the current Worker to activate the simplified monitor');\n liveUpdated=data.updatedAt||data.checkedAt||null;queueData=data.queue||null;\n if(queueData){$('queueResolved').textContent=compact(queueData.resolved);$('queueAdded').textContent=compact(queueData.added);$('queueTrend').textContent=queueData.ready?queueData.trend.charAt(0).toUpperCase()+queueData.trend.slice(1):'Measuring';}\n sectionAges();sourceInfo=data.sourceAccount||null;lastMigrationAt=data.lastMigrationAt||null;sourceAges();\n $('sourceBalance').textContent=sourceInfo?.balance!=null?compact(sourceInfo.balance)+' Pi':'—';$('sourceBalance').title=sourceInfo?.balance!=null?sourceInfo.balance+' Pi':'Balance unavailable';\n for(const key of ['first','second']){const value=data.volumes?.[key+'Pi'];$(key+'Pi').textContent=value!=null?compact(value)+' Pi':'—';$(key+'Pi').title=value!=null?value+' Pi · confirmed migrations since tracking started':'Awaiting accumulated amounts';}\n const validStart=data.startedAt&&Number.isFinite(Date.parse(data.startedAt));\n const cardPeriod=validStart?'Since '+new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}).format(new Date(data.startedAt))+' · UTC':'Since tracking began · date pending';\n for(const key of ['first','second']){$(key+'Period').textContent=cardPeriod;$(key+'Period').title=validStart?'Exact tracking start: '+new Date(data.startedAt).toISOString():'Waiting for the first successful collection';}\n $('period').textContent=data.startedAt?'Tracking since '+date(data.startedAt):'Tracking starts on the first scheduled collection';\n if(data.counts){number('first',data.counts.first);number('second',data.counts.second);$('pending').textContent=full(data.counts.pending)+' received events · awaiting classification'+(data.historyError?' · classification delayed':'');}\n const delayed=!!data.error||!data.checkedAt||Date.now()-Date.parse(data.checkedAt)>180000;\n $('health').textContent=delayed?'Delayed':data.backlog?'Catching up':'Collection online';$('health').className='chip'+(delayed||data.backlog?' warn':'');\n $('freshness').textContent=(data.checkedAt?'Last successful collection: '+date(data.checkedAt):'Waiting for the first scheduled collection')+(data.error?' · '+data.error:'')+(data.backlog?' · New receipts are queued.':'');ranking(data.ranking);\n}catch(error){$('health').textContent='Unavailable';$('health').className='chip warn';$('freshness').textContent=error.message+' · Previously displayed numbers may be stale.';}finally{loading=false;}}\nlet historyLoading=false;\nasync function refreshHistorical(){\n if(historyLoading||document.hidden)return;historyLoading=true;\n try{\n  const response=await fetch('/historical',{cache:'no-store',signal:AbortSignal.timeout(10000)});const data=await response.json();\n  if(!response.ok)throw new Error(data.error||'Historical collector unavailable');\n  const h=data.historical||{},pending=data.counts?.pending;\n  historyUpdated=data.checkedAt||null;historyQueue=data.queue||null;\n  const begin=Date.parse(h.since),end=Date.parse(h.targetAt),through=Date.parse(h.scannedThrough);\n  const coverage=Number.isFinite(begin)&&Number.isFinite(end)&&end>begin?(h.sourceComplete?100:Number.isFinite(through)?Math.min(100,Math.max(0,100*(through-begin)/(end-begin))):0):0;\n  $('historyBar').value=coverage;$('historyBarLabel').textContent='Date coverage: '+coverage.toFixed(1)+'% of the target interval';\n  const pace=queueView(historyQueue,!!(historyUpdated&&Date.now()-Date.parse(historyUpdated)>900000));\n  $('historyPace').textContent=pace.pace+' · '+pace.eta;\n  if(data.counts)number('historyWallets',data.counts.second);\n  if(data.volumes){$('historyPi').textContent=compact(data.volumes.secondPi)+' Pi';$('historyPi').title=data.volumes.secondPi+' Pi';}\n  const stale=data.checkedAt&&Date.now()-Date.parse(data.checkedAt)>15*60000;\n  const complete=h.sourceComplete&&pending===0&&!data.error&&!data.historyError&&!stale;\n  $('historyHealth').textContent=data.error||stale?'Delayed':h.initializing?'Preparing':complete?'Verified to target':'Partial';\n  $('historyHealth').className='chip'+(complete?'':' warn');\n  $('historyProgress').textContent=h.initializing?'Collection coverage: locating February 1, 2026.':(h.scannedThrough?'Collection coverage: scanned through '+date(h.scannedThrough):'Collection coverage: starting')+(h.targetAt?' · target '+date(h.targetAt):'');\n  $('historyPending').textContent=(pending!=null?'Classification: '+full(pending)+' received events awaiting review':'Classification: awaiting received events')+(h.sourceComplete?' · collection reached the target date':' · collection still in progress');\n  $('historyErrors').textContent=[data.error,data.historyError].filter(Boolean).join(' · ');sectionAges();\n }catch(error){$('historyHealth').textContent='Unavailable';$('historyHealth').className='chip warn';$('historyErrors').textContent=error.message+' · Previously displayed numbers may be stale.';}finally{historyLoading=false;}\n}\nrefreshHistorical();setInterval(refreshHistorical,60000);\nrefresh();setInterval(refresh,20000);document.addEventListener('visibilitychange',()=>{if(!document.hidden){refresh();refreshHistorical();}});\n</script></body></html>";
function json(value,status=200){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});}
export default {
 async scheduled(event,env,ctx){ctx.waitUntil(event.cron==='*/5 * * * *'?collectHistorical(env):collectFocus(env));},
 async fetch(request,env){
  const path=new URL(request.url).pathname;
  if(path==='/historical'){
   if(request.method!=='GET')return json({error:'Method not allowed'},405);
   try{const row=await env.DB.prepare('SELECT snapshot FROM historical2026_control WHERE id=1').first();return json(row?.snapshot?JSON.parse(row.snapshot):{historical:{since:HISTORICAL_SINCE,initializing:true},counts:null});}catch(e){if(String(e.message).includes('no such table'))return json({historical:{since:HISTORICAL_SINCE,initializing:true},counts:null});return json({error:'Historical data unavailable: '+e.message},503);}
  }
  if(path==='/live'){
   if(request.method!=='GET')return json({error:'Method not allowed'},405);
   try{const row=await env.DB.prepare('SELECT snapshot FROM focus_control WHERE id=1').first();return json(row?.snapshot?JSON.parse(row.snapshot):{version:45,startedAt:null,counts:null,error:'Waiting for first scheduled collection'});}catch{return json({error:'Collector not initialized; check DB binding and Cron Trigger'},503);}
  }
  if(path==='/stats'||path.startsWith('/d1/')||path==='/wallet-balances'||path.startsWith('/horizon/'))return json({error:'Legacy analytics disabled in v36. Use /live.'},410);
  if(path==='/'&&request.method==='GET')return new Response(PAGE,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
  return json({error:'Not found'},404);
 }
};