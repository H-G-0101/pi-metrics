// Reliability helpers: bounded work, fail-closed evidence and no financial promises.
export function pendingReason(proof={}){
 if(proof.ambiguous)return 'Ambiguous recipient history';
 if(proof.complete&&!proof.genesis)return 'Account creation missing from available history';
 if(proof.error)return 'API error · retry scheduled';
 if(!proof.cursor)return 'Waiting for the first history query';
 return 'History scan in progress';
}
export function meteredDatabase(raw){
 const usage={reportedWrites:0,estimatedWrites:0,rowsRead:0,missingMetadata:0};
 const estimate=(sql,args)=>{
  if(/^\s*(SELECT|PRAGMA)/i.test(sql))return 0;
  if(/INSERT INTO focus_(events|wallets)/.test(sql)){try{return JSON.parse(args[0]).length*6;}catch{}}
  return 1;
 };
 function record(r,sql,args){
  if(Number.isFinite(r?.meta?.rows_written))usage.reportedWrites+=r.meta.rows_written;
  else {const cost=estimate(sql,args);usage.estimatedWrites+=cost;if(cost)usage.missingMetadata++;}
  if(Number.isFinite(r?.meta?.rows_read))usage.rowsRead+=r.meta.rows_read;
  return r;
 }
 function wrap(sql,args=[]){const stmt=args.length?raw.prepare(sql).bind(...args):raw.prepare(sql);return {_raw:stmt,_sql:sql,_args:args,
  bind(...values){return wrap(sql,values);},
  async all(){return record(await stmt.all(),sql,args);},
  async first(){const r=record(await stmt.all(),sql,args);return r.results?.[0]||null;},
  async run(){return record(await stmt.run(),sql,args);}
 };}
 return {usage,prepare:wrap,async batch(statements){const result=await raw.batch(statements.map(s=>s._raw));return result.map((r,i)=>record(r,statements[i]._sql,statements[i]._args));}};
}
export async function adaptiveController(DB){
 await DB.batch([DB.prepare('CREATE TABLE IF NOT EXISTS collector_api_control(id INTEGER PRIMARY KEY,state TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0)'),DB.prepare("INSERT OR IGNORE INTO collector_api_control(id,state) VALUES(1,'{}')")]);
 const row=await DB.prepare('SELECT state,revision FROM collector_api_control WHERE id=1').first();
 const saved=JSON.parse(row.state);let level=Math.max(1,Math.min(4,saved.level||4)),successes=Number(saved.successes||0),pauseUntil=Number(saved.pauseUntil||0),failed=false,reason=saved.reason||null,calls=0;
 return {get level(){return level;},get paused(){return pauseUntil>Date.now();},get calls(){return calls;},
  good(){calls++;successes++;if(successes>=30&&level<4){level++;successes=0;}},
  bad(error){if(error?.adaptiveHandled)return;error.adaptiveHandled=true;calls++;if(!failed)level=Math.max(1,Math.floor(level/2));failed=true;successes=0;reason=String(error.message||error);pauseUntil=Math.max(pauseUntil,Date.now()+Math.min(3600000,Math.max(300000,Number(error.retryAfterMs)||0)));},
  snapshot(){return {parallelism:level,pauseUntil:pauseUntil?new Date(pauseUntil).toISOString():null,reason:pauseUntil>Date.now()?reason:null};},
  async persist(){
   if(failed){await DB.prepare("UPDATE collector_api_control SET state=json_set(state,'$.level',MIN(COALESCE(json_extract(state,'$.level'),4),?1),'$.successes',0,'$.pauseUntil',MAX(COALESCE(json_extract(state,'$.pauseUntil'),0),?2),'$.reason',?3),revision=revision+1 WHERE id=1").bind(level,pauseUntil,reason).run();}
   else if(calls){await DB.prepare('UPDATE collector_api_control SET state=?1,revision=revision+1 WHERE id=1 AND revision=?2').bind(JSON.stringify({level,successes,pauseUntil,reason}),row.revision).run();}
  }
 };
}
export function adjustAudit(audit,address,before,after){
 if(!audit||audit.status!=='scanning'||!audit.cursor||address>audit.cursor)return audit;
 const copy=structuredClone(audit);
 for(const key of ['first','second','pending'])copy.counts[key]+=after.counts[key]-before.counts[key];
 for(const key of ['first','second'])copy.volumes[key]=String(BigInt(copy.volumes[key])+BigInt(after.volumes[key])-BigInt(before.volumes[key]));
 return copy;
}
export function auditTotals(events){
 return {counts:{first:Number(events.some(e=>e.round===1)),second:Number(events.some(e=>e.round===2)),pending:events.filter(e=>e.round==null).length},volumes:{first:events.filter(e=>e.round===1).reduce((n,e)=>n+BigInt(e.units),0n).toString(),second:events.filter(e=>e.round===2).reduce((n,e)=>n+BigInt(e.units),0n).toString()}};
}
export async function auditStep(DB,state,now=Date.now(),size=250){
 let audit=state.audit;
 if(audit?.status!=='scanning'){
  if(audit?.checkedAt&&now-Date.parse(audit.checkedAt)<86400000)return audit;
  audit={status:'scanning',startedAt:new Date(now).toISOString(),cursor:'',wallets:0,counts:{first:0,second:0,pending:0},volumes:{first:'0',second:'0'},issues:[]};
 }else audit=structuredClone(audit);
 // Walk events by their primary key prefix: orphan events are included, too.
 const addresses=(await DB.prepare('SELECT DISTINCT address FROM focus_events WHERE address>?1 ORDER BY address LIMIT ?2').bind(audit.cursor,size).all()).results||[];
 if(addresses.length){
  const ids=JSON.stringify(addresses.map(r=>r.address));
  const records=(await DB.prepare('SELECT address,round,units FROM focus_events WHERE address IN (SELECT value FROM json_each(?1))').bind(ids).all()).results||[];
  const wallets=new Map(((await DB.prepare('SELECT address,pending FROM focus_wallets WHERE address IN (SELECT value FROM json_each(?1))').bind(ids).all()).results||[]).map(w=>[w.address,w.pending]));
  for(const {address} of addresses){const totals=auditTotals(records.filter(e=>e.address===address));for(const k of ['first','second','pending'])audit.counts[k]+=totals.counts[k];for(const k of ['first','second'])audit.volumes[k]=String(BigInt(audit.volumes[k])+BigInt(totals.volumes[k]));if(wallets.get(address)!==totals.counts.pending&&audit.issues.length<10)audit.issues.push(address);}
  audit.cursor=addresses.at(-1).address;audit.wallets+=addresses.length;
 }
 if(addresses.length<size){audit.checkedAt=new Date(now).toISOString();const matches=['first','second','pending'].every(k=>audit.counts[k]===state.counts[k])&&['first','second'].every(k=>audit.volumes[k]===state.volumeUnits[k]);audit.status=matches&&!audit.issues.length?'consistent':'mismatch';}
 return audit;
}
export function publicAudit(audit){return audit?{status:audit.status,startedAt:audit.startedAt,checkedAt:audit.checkedAt||null,wallets:audit.wallets,issues:audit.issues.length}:null;}
