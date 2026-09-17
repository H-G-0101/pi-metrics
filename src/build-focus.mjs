import {readFileSync,writeFileSync} from 'node:fs';
const html=readFileSync(new URL('./focus.html',import.meta.url),'utf8');
const collector=readFileSync(new URL('./focus.mjs',import.meta.url),'utf8').replace(/^export /gm,'');
const worker=`// Generated v40: focused migration collector and cached source balance.
${collector}
const PAGE=${JSON.stringify(html)};
function json(value,status=200){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});}
export default {
 async scheduled(event,env,ctx){ctx.waitUntil(collectFocus(env));},
 async fetch(request,env){
  const path=new URL(request.url).pathname;
  if(path==='/live'){
   if(request.method!=='GET')return json({error:'Method not allowed'},405);
   try{const row=await env.DB.prepare('SELECT snapshot FROM focus_control WHERE id=1').first();return json(row?.snapshot?JSON.parse(row.snapshot):{version:40,startedAt:null,counts:null,error:'Waiting for first scheduled collection'});}catch{return json({error:'Collector not initialized; check DB binding and Cron Trigger'},503);}
  }
  if(path==='/stats'||path.startsWith('/d1/')||path==='/wallet-balances'||path.startsWith('/horizon/'))return json({error:'Legacy analytics disabled in v36. Use /live.'},410);
  if(path==='/'&&request.method==='GET')return new Response(PAGE,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
  return json({error:'Not found'},404);
 }
};`;
writeFileSync(new URL('../worker.js',import.meta.url),worker);
console.log('Focused worker generated: '+worker.length+' bytes');
