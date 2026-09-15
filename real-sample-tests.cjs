const fs=require('node:fs'),vm=require('node:vm'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const fixture=require('./real-sample-v29.json');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pi-real-'));
let source=fs.readFileSync(path.join(__dirname,'migracao-stats.mjs'),'utf8').replace(/^#!.*\n/,'').replace(/import \{[\s\S]*?\} from 'node:fs';/,'');
source=source.slice(0,source.lastIndexOf('(async () => {'))+'\nglobalThis.api={verifyTopWallets,classifyRecentEvents,state};';
(async()=>{
 for(const wallet of fixture.wallets){
  const ctx={...fs,console,URL,AbortSignal,setTimeout,clearTimeout,process:{env:{CHECKPOINT_FILE:path.join(temp,wallet.address),THROTTLE_MS:'0'},on:()=>{}},fetch:async()=>({ok:true,json:async()=>({_embedded:{records:wallet.records}})})};
  vm.createContext(ctx);vm.runInContext(source,ctx);
  const ops=wallet.records.filter(op=>op.type==='create_claimable_balance'&&op.source_account===ctx.api.state.wallet);
  const hash=ops.at(-1).transaction_hash;
  ctx.api.state.recentEvents.test={address:wallet.address,transactionHash:hash,createdAt:new Date().toISOString(),amountPi:1,balanceCount:1,tranches:[]};
  await ctx.api.verifyTopWallets();
  const actual=ctx.api.classifyRecentEvents()[0];
  assert.equal(actual.migrationNumber,wallet.expectedLatestRound);
  assert.equal(actual.classifiedBy,'wallet_history');
  console.log('PASS real wallet:',wallet.address,'round',actual.migrationNumber);
 }
})().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>fs.rmSync(temp,{recursive:true,force:true}));
