// v36: new receipts only, persistent ordinal evidence, no rolling analytics.
const SOURCE='GABT7EMPGNCQSZM22DIYC4FNKHUVJTXITUF6Y5HNIWPU4GA7BHT4GC5G';
const RECOVERY='GC5RNDCRO6DDM7NZDEMW3RIN5K6AHN6GMWSZ5SAH2TRJLVGQMB2I3BNJ';
const API='https://api.mainnet.minepi.com';
export const focusSchema=[
  'CREATE TABLE IF NOT EXISTS focus_control(id INTEGER PRIMARY KEY,state TEXT NOT NULL,snapshot TEXT,owner TEXT,lease_until INTEGER NOT NULL DEFAULT 0)',
  "INSERT OR IGNORE INTO focus_control(id,state) VALUES(1,'{}')",
  'CREATE TABLE IF NOT EXISTS focus_events(address TEXT NOT NULL,hash TEXT NOT NULL,at TEXT NOT NULL,units TEXT NOT NULL,ids TEXT NOT NULL,round INTEGER,PRIMARY KEY(address,hash))',
  'CREATE INDEX IF NOT EXISTS focus_event_date ON focus_events(at)',
  'CREATE TABLE IF NOT EXISTS focus_wallets(address TEXT PRIMARY KEY,evidence TEXT NOT NULL,pending INTEGER NOT NULL,retry_at TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS focus_pending ON focus_wallets(retry_at,address) WHERE pending>0',
];
export function focusReceipt(op){
  if(op.type!=='create_claimable_balance'||op.source_account!==SOURCE||op.asset!=='native'||op.transaction_successful===false)return null;
  const targets=(op.claimants||[]).filter(c=>c.destination&&c.destination!==SOURCE&&c.destination!==RECOVERY);
  if(targets.length!==1)return null;
  if(!/^\d+(\.\d{1,7})?$/.test(String(op.amount)))throw new Error('Invalid migration amount');
  const [whole,fraction='']=String(op.amount).split('.');
  const units=BigInt(whole)*10000000n+BigInt(fraction.padEnd(7,'0'));
  if(units>9223372036854775807n)throw new Error('Migration amount too large');
  return {address:targets[0].destination,hash:op.transaction_hash,at:new Date(op.created_at).toISOString(),units:String(units),id:String(op.id||op.paging_token)};
}
export function focusRound(evidence,hash){
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
export async function focusVerificationQueue(DB,ranking,now,size=4){
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
export async function collectFocus(env,options={}){
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
