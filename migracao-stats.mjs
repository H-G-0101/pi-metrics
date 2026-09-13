#!/usr/bin/env node
/**
 * Indexador de migrações da Pi Network.
 *
 * Regra:
 * - cada transaction_hash distinto que cria um ou mais claimable balances para
 *   a mesma carteira representa UM evento de migração;
 * - o primeiro hash é a 1ª migração e o segundo hash é a 2ª migração;
 * - dois balances no mesmo hash são parcelas (curta/longa) da mesma migração;
 * - claim_claimable_balance é resgate e não cria uma nova migração.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

const HORIZON = process.env.HORIZON || 'https://api.mainnet.minepi.com';
const WALLET = process.env.WALLET || 'GABT7EMPGNCQSZM22DIYC4FNKHUVJTXITUF6Y5HNIWPU4GA7BHT4GC5G';
const RECOVERY_WALLET = process.env.RECOVERY_WALLET
  || 'GC5RNDCRO6DDM7NZDEMW3RIN5K6AHN6GMWSZ5SAH2TRJLVGQMB2I3BNJ';

const PAGE_LIMIT = Math.min(200, Math.max(1, Number(process.env.PAGE_LIMIT || 200)));
const CHECKPOINT_EVERY = Math.max(1, Number(process.env.CHECKPOINT_EVERY || 100));
const PUSH_EVERY_PAGES = Math.max(1, Number(process.env.PUSH_EVERY_PAGES || 250));
const RECENT_PUSH_EVERY_PAGES = Math.max(1, Number(process.env.RECENT_PUSH_EVERY_PAGES || 25));
const THROTTLE_MS = Math.max(0, Number(process.env.THROTTLE_MS || 40));
const MAX_PAGES = Math.max(0, Number(process.env.MAX_PAGES || 0));
// Com SKIP_HISTORY, o cursor pula direto para o presente: só as migrações
// daqui pra frente entram no índice. O passado não indexado é abandonado.
const SKIP_HISTORY = /^(1|true|yes|sim)$/i.test(process.env.SKIP_HISTORY || '');
// Sem create_account na transação, a conta já existia antes do evento: só pode
// ser a 2ª migração. Usado apenas quando o índice não conhece o hash.
// Ponha INFER_SECOND=0 para voltar a depender só do índice.
const INFER_SECOND = !/^(0|false|no|nao|não)$/i.test(process.env.INFER_SECOND || '1');
const PUSH_URL = process.env.PUSH_URL || '';
const PUSH_TOKEN = process.env.PUSH_TOKEN || '';
const WORKER_BASE = process.env.WORKER_BASE
  || PUSH_URL.replace(/\/stats(?:\?.*)?$/, '');
const D1_SYNC_URL = WORKER_BASE ? `${WORKER_BASE}/d1/sync` : '';
const D1_RESTORE_URL = WORKER_BASE ? `${WORKER_BASE}/d1/restore` : '';
const D1_SEED_LIMIT = Math.max(100, Number(process.env.D1_SEED_LIMIT || 15000));
const D1_BATCH_SIZE = 32;
// Free tier do D1: 100.000 linhas escritas por dia (UTC). Cada carteira grava a
// linha da tabela + a linha do índice idx_wallets_second_at, então o custo real
// é ~2 linhas por carteira. 0 desliga o controle (plano pago).
const D1_DAILY_ROW_BUDGET = Math.max(0, Number(process.env.D1_DAILY_ROW_BUDGET || 85000));
const D1_ROWS_PER_WALLET = Math.max(1, Number(process.env.D1_ROWS_PER_WALLET || 2));
const CK = process.env.CHECKPOINT_FILE || './checkpoint.json';
const CK_PARTS = `${CK}.parts`;
const CHECKPOINT_SHARD_SIZE = Math.max(1000, Number(process.env.CHECKPOINT_SHARD_SIZE || 25000));
const OUT = process.env.OUTPUT_FILE || './migracao-stats.json';
const STATE_VERSION = 3;
const WEEK_MS = 7 * 86400000;
const RECENT_RETENTION_MS = 15 * 86400000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function emptyState() {
  return {
    version: STATE_VERSION,
    wallet: WALLET,
    recoveryWallet: RECOVERY_WALLET,
    cursor: '',
    pages: 0,
    scannedRecords: 0,
    claimableBalances: 0,
    byDest: {},
    recentEvents: {},
    recentCreatedAccountKeys: {},
    recentScan: null,
    lastSeenAt: null,
    d1Ready: false,
    d1SeedOffset: 0,
    d1Budget: { day: '', rows: 0 },
    coverageFrom: null,
  };
}

let checkpointLoaded = false;
function loadState() {
  if (!existsSync(CK)) return emptyState();
  try {
    const saved = JSON.parse(readFileSync(CK, 'utf8'));
    const compatible = saved.version === STATE_VERSION
      && saved.wallet === WALLET
      && saved.recoveryWallet === RECOVERY_WALLET;
    if (compatible) {
      if (saved.sharded) {
        const byDest = {};
        const shardCount = Number(saved.shardCount || 0);
        for (let index = 0; index < shardCount; index++) {
          const part = `${CK_PARTS}/${saved.generation ? saved.generation + "/" : ""}part-${String(index).padStart(5, '0')}.json`;
          if (!existsSync(part)) throw new Error(`parte ausente: ${part}`);
          for (const [address, entry] of JSON.parse(readFileSync(part, 'utf8'))) {
            byDest[address] = entry;
          }
        }
        saved.byDest = byDest;
        console.log(`Checkpoint restaurado em ${shardCount.toLocaleString('pt-BR')} partes.`);
      }
      checkpointLoaded = true;
      saved.recentEvents ||= {};
      delete saved.recentCreateAccountTxs;
      saved.recentCreatedAccountKeys = {};
      saved.recentScan ||= null;
      saved.d1Ready ||= false;
      saved.d1SeedOffset = Number(saved.d1SeedOffset || 0);
      saved.coverageFrom = saved.coverageFrom || null;
      saved.d1Budget = saved.d1Budget && typeof saved.d1Budget === 'object'
        ? { day: String(saved.d1Budget.day || ''), rows: Number(saved.d1Budget.rows || 0) }
        : { day: '', rows: 0 };
      return saved;
    }
    console.log('Checkpoint antigo ou incompatível; iniciando o índice correto do zero.');
  } catch (error) {
    console.log(`Checkpoint inválido (${error.message}); iniciando do zero.`);
  }
  return emptyState();
}

let state = loadState();
let d1Error = null;
let d1Enabled = Boolean(D1_SYNC_URL && D1_RESTORE_URL && PUSH_TOKEN);
let d1Paused = false;

const utcDay = () => new Date().toISOString().slice(0, 10);

function budget() {
  if (!state.d1Budget || state.d1Budget.day !== utcDay()) {
    state.d1Budget = { day: utcDay(), rows: 0 };
  }
  return state.d1Budget;
}

function budgetLeft() {
  if (!D1_DAILY_ROW_BUDGET) return Number.POSITIVE_INFINITY;
  return Math.max(0, D1_DAILY_ROW_BUDGET - budget().rows);
}

function spendBudget(rows) { budget().rows += rows; }
function exhaustBudget() { budget().rows = D1_DAILY_ROW_BUDGET || Number.MAX_SAFE_INTEGER; }

// Estouro de cota não é falha do crawler: o índice local continua válido.
function isQuotaError(message) {
  return /row write limit|daily row|exceeded .*limit|free tier/i.test(String(message || ''));
}

function pauseD1(message, exhaust = false) {
  if (exhaust) exhaustBudget();
  d1Enabled = false;
  d1Paused = true;
  d1Error = message;
  console.log(`D1 pausado até o próximo dia UTC (${message}).`);
  console.log('O índice continua no checkpoint local; a sincronização recomeça no próximo run.');
}

function d1Meta(complete = false) {
  return {
    formatVersion: 26,
    wallet: WALLET,
    cursor: state.cursor,
    pages: state.pages,
    scannedRecords: state.scannedRecords,
    claimableBalances: state.claimableBalances,
    lastSeenAt: state.lastSeenAt,
    complete,
  };
}

function walletSnapshot(address) {
  const entry = state.byDest[address];
  return entry && {
    address,
    firstTx: entry.firstTx,
    firstAt: entry.firstAt,
    secondTx: entry.secondTx,
    secondAt: entry.secondAt,
    lastTx: entry.lastTx,
    eventCount: entry.eventCount,
  };
}

async function callD1(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    signal: AbortSignal.timeout(30000),
    headers: {
      authorization: `Bearer ${PUSH_TOKEN}`,
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`D1 HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

async function syncD1Wallets(wallets, meta = null) {
  if (!d1Enabled) return;
  const rows = wallets.filter(Boolean);
  // One historical page and its cursor must commit together.
  if (rows.length > 200) throw new Error('D1 page exceeds 200 wallets');
  const cost = rows.length * D1_ROWS_PER_WALLET + (meta ? 1 : 0);
  if (cost > budgetLeft()) {
    pauseD1('orçamento diário de escrita atingido', true);
    return;
  }
  try {
    await callD1(D1_SYNC_URL, {method:'POST', body:JSON.stringify({wallets:rows,meta})});
    spendBudget(cost);
  } catch (error) {
    if (isQuotaError(error.message)) { pauseD1(error.message, true); return; }
    throw error;
  }
}

async function restoreFromD1() {
  state.d1Ready = false;
  if (!d1Enabled) return false;
  try {
    const head = await callD1(D1_RESTORE_URL + '?metaOnly=1');
    if(head.protocol!==26)throw new Error('Deploy the v26 Worker before running this crawler');
    const meta = head.meta;
    if (!meta || meta.rebuilding) {
      if (!checkpointLoaded && meta?.rebuilding) throw new Error('D1 snapshot incomplete; restore the saved checkpoint before continuing');
      state.d1SeedOffset=0;
      return false;
    }
    if (meta.wallet && meta.wallet !== WALLET) throw new Error('D1 wallet mismatch');
    if (checkpointLoaded && BigInt(state.cursor || '0') >= BigInt(meta.cursor || '0')) {
      if(meta.formatVersion===26 && state.cursor===meta.cursor){state.d1Ready=true;return true;}
      // O checkpoint local está à frente do D1 (sync interrompida por cota, por
      // exemplo). Rebobinar o cursor até o ponto do D1 custa páginas do Horizon,
      // mas é idempotente e evita recopiar milhões de carteiras.
      if (meta.formatVersion === 26 && meta.cursor) {
        console.log(`Checkpoint à frente do D1; rebobinando o cursor para ${meta.cursor}.`);
        state.cursor = meta.cursor;
        state.pages = Number(meta.pages || 0);
        state.scannedRecords = Number(meta.scannedRecords || 0);
        state.claimableBalances = Number(meta.claimableBalances || 0);
        state.d1Ready = true;
        state.d1SeedOffset = 0;
        return true;
      }
      // Recopy a frozen local snapshot, including entries changed since an old seed.
      state.d1SeedOffset=0;
      return false;
    }
    let after=''; const restoredIndex={};
    do {
      const data=await callD1(D1_RESTORE_URL+'?after='+encodeURIComponent(after));
      if (JSON.stringify(data.meta)!==JSON.stringify(meta)) throw new Error('D1 changed during restore; retry next run');
      for(const row of data.wallets || []) {
        restoredIndex[row.address]={firstTx:row.firstTx,firstAt:row.firstAt,secondTx:row.secondTx,secondAt:row.secondAt,lastTx:row.lastTx,eventCount:Number(row.eventCount||1)};
        after=row.address;
      }
      if(!data.hasMore)break;
      if(!(data.wallets||[]).length)throw new Error('Incomplete D1 pagination');
    }while(true);
    if(meta.walletCount != null && Object.keys(restoredIndex).length!==meta.walletCount)throw new Error('D1 wallet count mismatch');
    state.byDest=restoredIndex;state.cursor=meta.cursor||'';state.pages=Number(meta.pages||0);
    state.scannedRecords=Number(meta.scannedRecords||0);state.claimableBalances=Number(meta.claimableBalances||0);
    state.lastSeenAt=meta.lastSeenAt||null;state.d1Ready=true;state.d1SeedOffset=0;
    console.log('D1 snapshot restored and verified');return true;
  }catch(error){
    d1Error=error.message;d1Enabled=false;state.d1Ready=false;
    // Never mix a partial restore with a fresh or older index.
    throw error;
  }
}

async function seedD1() {
  if(!d1Enabled || state.d1Ready)return true;
  const addresses=Object.keys(state.byDest);
  const start=Math.min(Math.max(0,Number(state.d1SeedOffset||0)),addresses.length);
  try {
    // The historical cursor is frozen until every entry has been copied.
    if(start===0){
      await callD1(D1_SYNC_URL,{method:'POST',body:JSON.stringify({wallets:[],resetSnapshot:true,meta:{...d1Meta(false),rebuilding:true}})});
    }else{
      console.log(`Retomando a cópia para o D1 a partir da carteira ${start.toLocaleString('pt-BR')}.`);
    }
    for(let index=start;index<addresses.length;index+=D1_BATCH_SIZE){
      if(!d1Enabled){
        // Pausado por cota: guarda o ponto exato para o próximo run.
        state.d1SeedOffset=index;saveCheckpoint();return false;
      }
      await syncD1Wallets(addresses.slice(index,index+D1_BATCH_SIZE).map(walletSnapshot));
      state.d1SeedOffset=index+D1_BATCH_SIZE;
      if(state.d1SeedOffset % (D1_BATCH_SIZE*200) === 0)saveCheckpoint();
    }
    if(!d1Enabled){saveCheckpoint();return false;}
    await syncD1Wallets([],{...d1Meta(false),walletCount:addresses.length});
    state.d1Ready=true;state.d1SeedOffset=0;d1Error=null;
    console.log('D1 frozen snapshot committed');return true;
  }catch(error){
    d1Error=error.message;state.d1Ready=false;d1Enabled=false;
    if(isQuotaError(error.message)){pauseD1(error.message,true);saveCheckpoint();return false;}
    throw error;
  }
}

async function getPage(cursor, order = 'asc') {
  const url = `${HORIZON}/accounts/${WALLET}/operations`
    + `?order=${order}&limit=${PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;

  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { Accept: 'application/json' } });
    if (response.status === 429 || response.status >= 500) {
      const wait = Math.min(60000, 2000 * 2 ** attempt);
      console.log(`  ↳ Horizon ${response.status}; nova tentativa em ${wait / 1000}s…`);
      await sleep(wait);
      continue;
    }
    if (!response.ok) throw new Error(`Horizon HTTP ${response.status} — ${await response.text()}`);
    return response.json();
  }
}

function migrationRecipient(operation) {
  if (operation.type !== 'create_claimable_balance' || operation.source_account !== WALLET) {
    return null;
  }
  const claimants = operation.claimants || [];
  return claimants.find(claimant =>
    claimant.destination
    && claimant.destination !== RECOVERY_WALLET
    && claimant.destination !== WALLET
  );
}

function migrationDestination(operation) {
  return migrationRecipient(operation)?.destination || null;
}

function absolutePredicateMs(value) {
  if (value == null) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function unlockTimeFromPredicate(predicate, createdAt) {
  if (!predicate || typeof predicate !== 'object') return null;
  const createdMs = Date.parse(createdAt);
  if (predicate.not?.rel_before != null && Number.isFinite(createdMs)) {
    return createdMs + Number(predicate.not.rel_before) * 1000;
  }
  if (predicate.not?.abs_before != null) return absolutePredicateMs(predicate.not.abs_before);
  if (Array.isArray(predicate.and)) {
    const times = predicate.and.map(item => unlockTimeFromPredicate(item, createdAt)).filter(Number.isFinite);
    return times.length ? Math.max(...times) : null;
  }
  if (Array.isArray(predicate.or)) {
    const times = predicate.or.map(item => unlockTimeFromPredicate(item, createdAt)).filter(Number.isFinite);
    return times.length ? Math.min(...times) : null;
  }
  return null;
}

function migrationTranche(operation) {
  const recipient = migrationRecipient(operation);
  const createdMs = Date.parse(operation.created_at);
  const unlockMs = unlockTimeFromPredicate(recipient?.predicate, operation.created_at);
  return {
    amountPi: +Number(operation.amount || 0).toFixed(7),
    lockSeconds: Number.isFinite(unlockMs) && Number.isFinite(createdMs)
      ? Math.max(0, Math.round((unlockMs - createdMs) / 1000))
      : null,
    unlockAt: Number.isFinite(unlockMs) ? new Date(unlockMs).toISOString() : null,
  };
}

function migrationNumber(entry, tx, at) {
  if (entry.firstTx === tx) return 1;
  if (entry.secondTx === tx) return 2;
  if (entry.lastTx === tx) return entry.eventCount;

  entry.eventCount++;
  entry.lastTx = tx;
  if (entry.eventCount === 1) {
    entry.firstTx = tx;
    entry.firstAt = at;
  } else if (entry.eventCount === 2) {
    entry.secondTx = tx;
    entry.secondAt = at;
  }
  return entry.eventCount;
}

function record(operation) {
  state.scannedRecords++;
  if (operation.created_at) state.lastSeenAt = operation.created_at;

  const address = migrationDestination(operation);
  if (!address || !operation.transaction_hash) return null;

  state.claimableBalances++;
  const entry = state.byDest[address] || (state.byDest[address] = {
    firstTx: null,
    firstAt: null,
    secondTx: null,
    secondAt: null,
    lastTx: null,
    eventCount: 0,
  });
  migrationNumber(entry, operation.transaction_hash, operation.created_at);
  return address;
}

function addRecentOperation(events, operation) {
  const address = migrationDestination(operation);
  if (!address || !operation.transaction_hash) return;
  const key = `${address}:${operation.transaction_hash}`;
  const event = events[key] || (events[key] = {
    address,
    transactionHash: operation.transaction_hash,
    createdAt: operation.created_at,
    amountPi: 0,
    balanceCount: 0,
    tranches: [],
  });
  event.amountPi += Number(operation.amount || 0);
  event.balanceCount++;
  event.tranches.push(migrationTranche(operation));
}

async function refreshRecentEvents() {
  const cutoff = Date.now() - RECENT_RETENTION_MS;
  let cursor = '';
  let pages = 0;

  state.recentEvents = {};
  state.recentCreatedAccountKeys = {};
  state.recentScan = {
    complete: false,
    pages: 0,
    newestAt: null,
    oldestAt: null,
    startedAt: new Date().toISOString(),
    cutoffAt: new Date(cutoff).toISOString(),
  };
  console.log('Atualizando primeiro a janela recente de 15 dias…');
  while (true) {
    const page = await getPage(cursor, 'desc');
    const records = page._embedded?.records || [];
    if (!records.length) break;

    let reachedCutoff = false;
    for (const operation of records) {
      if (Date.parse(operation.created_at) < cutoff) {
        reachedCutoff = true;
        continue;
      }
      if (
        operation.type === 'create_account'
        && operation.source_account === WALLET
        && operation.transaction_hash
        && operation.account
      ) {
        state.recentCreatedAccountKeys[`${operation.transaction_hash}:${operation.account}`] = true;
      }
      addRecentOperation(state.recentEvents, operation);
    }

    pages++;
    cursor = records.at(-1).paging_token;
    const validDates = records.map(row => row.created_at).filter(Boolean).sort();
    state.recentScan.pages = pages;
    state.recentScan.newestAt ||= validDates.at(-1) || null;
    state.recentScan.oldestAt = validDates[0] || state.recentScan.oldestAt;

    if (pages === 1 || pages % RECENT_PUSH_EVERY_PAGES === 0) {
      console.log(`Publicando amostra recente parcial (${pages.toLocaleString('pt-BR')} páginas)…`);
      await publishProgress(false);
    }
    if (reachedCutoff || records.length < PAGE_LIMIT) break;
    await sleep(THROTTLE_MS);
  }

  state.recentScan.complete = true;
  state.recentScan.completedAt = new Date().toISOString();
  console.log(
    `Janela recente pronta: ${Object.keys(state.recentEvents).length.toLocaleString('pt-BR')} eventos em `
    + `${pages.toLocaleString('pt-BR')} páginas.`,
  );
}

// Move o cursor histórico para a operação mais recente da carteira. É
// idempotente: se um rebobinamento de cursor acontecer antes, este salto o
// anula, então o crawl nunca volta ao passado com SKIP_HISTORY ligado.
async function jumpToPresent() {
  const page = await getPage('', 'desc');
  const records = page._embedded?.records || [];
  if (!records.length) return false;
  const token = records[0].paging_token;
  if (state.cursor && BigInt(state.cursor) >= BigInt(token)) return false;
  console.log(`SKIP_HISTORY: cursor movido para o presente (${records[0].created_at}).`);
  console.log('O histórico anterior não será indexado; só migrações novas entram daqui pra frente.');
  state.cursor = token;
  state.lastSeenAt = records[0].created_at;
  // Marca de onde o índice passa a ser confiável (só no primeiro salto).
  state.coverageFrom ||= records[0].created_at;
  return true;
}

function pruneRecentEvents(now = Date.now()) {  const cutoff = now - RECENT_RETENTION_MS;
  for (const [key, event] of Object.entries(state.recentEvents)) {
    if (Date.parse(event.createdAt) < cutoff) delete state.recentEvents[key];
  }
}

function saveCheckpoint() {
  pruneRecentEvents();
  mkdirSync(CK_PARTS, { recursive: true });
  const generation = `generation-${Date.now()}`;
  const generationDir = `${CK_PARTS}/${generation}`;
  mkdirSync(generationDir,{recursive:true});
  let shard = [];
  let shardCount = 0;
  const flushShard = () => {
    if (!shard.length) return;
    const part = `${generationDir}/part-${String(shardCount).padStart(5, '0')}.json`;
    const tempPart = `${part}.tmp`;
    writeFileSync(tempPart, JSON.stringify(shard));
    renameSync(tempPart, part);
    shard = [];
    shardCount++;
  };
  for (const address in state.byDest) {
    if (!Object.hasOwn(state.byDest, address)) continue;
    shard.push([address, state.byDest[address]]);
    if (shard.length >= CHECKPOINT_SHARD_SIZE) flushShard();
  }
  flushShard();

  const temp = `${CK}.tmp`;
  // O índice histórico é dividido em arquivos menores e a janela recente não
  // é duplicada. Assim nenhuma chamada de JSON.stringify recebe milhões de linhas.
  const checkpointState = {
    ...state,
    byDest: {},
    recentEvents: {},
    recentCreatedAccountKeys: {},
    sharded: true,
    generation,
    shardCount,
  };
  writeFileSync(temp, JSON.stringify(checkpointState));
  renameSync(temp, CK);

  for (const filename of readdirSync(CK_PARTS)) {
    if(/^generation-\d+$/.test(filename) && filename!==generation){rmSync(`${CK_PARTS}/${filename}`,{recursive:true,force:true});continue;}
    const match = /^part-(\d{5})\.json$/.exec(filename);
    if (match && Number(match[1]) >= shardCount) unlinkSync(`${CK_PARTS}/${filename}`);
  }
}

function classifyRecentEvents() {
  const rows = Object.values(state.recentEvents)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  

  return rows.map(event => {
    const entry = state.byDest[event.address];
    let migrationNumber = null;
    let classifiedBy = null;
    const createdAccountKey = `${event.transactionHash}:${event.address}`;
    // Ordem: sinal on-chain direto > índice histórico > inferência.
    if (state.recentCreatedAccountKeys?.[createdAccountKey]) {
      migrationNumber = 1; classifiedBy = 'create_account';
    } else if (entry?.firstTx === event.transactionHash) {
      migrationNumber = 1; classifiedBy = 'index';
    } else if (entry?.secondTx === event.transactionHash) {
      migrationNumber = 2; classifiedBy = 'index';
    } else if (entry?.lastTx === event.transactionHash) {
      migrationNumber = entry.eventCount; classifiedBy = 'index';
    } else if (INFER_SECOND) {
      // A conta não nasceu nesta transação, logo já existia: 2ª migração.
      migrationNumber = 2; classifiedBy = 'inferred';
    }

    return { ...event, migrationNumber, classifiedBy };
  });
}

function dailySeries(days = 14, events = classifyRecentEvents()) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const rows = [];
  const byDate = new Map();
  for (let offset = days - 1; offset >= 0; offset--) {
    const date = new Date(today.getTime() - offset * 86400000).toISOString().slice(0, 10);
    const row = { date, first: 0, second: 0, pending: 0, firstPi: 0, secondPi: 0, pendingPi: 0 };
    rows.push(row);
    byDate.set(date, row);
  }
  for (const event of events) {
    const row = byDate.get(event.createdAt?.slice(0, 10));
    if (!row) continue;
    if (event.migrationNumber === 1) {
      row.first++;
      row.firstPi += Number(event.amountPi || 0);
    } else if (event.migrationNumber === 2) {
      row.second++;
      row.secondPi += Number(event.amountPi || 0);
    } else {
      row.pending++;
      row.pendingPi += Number(event.amountPi || 0);
    }
  }
  for (const row of rows) {
    row.firstPi = +row.firstPi.toFixed(7);
    row.secondPi = +row.secondPi.toFixed(7);
    row.pendingPi = +row.pendingPi.toFixed(7);
  }
  return rows;
}

function weeklyMetrics(now = Date.now(), events = classifyRecentEvents()) {
  const cutoff = now - WEEK_MS;
  const wallets = new Map();
  let totalPi = 0;
  let firstEvents = 0;
  let secondEvents = 0;
  let pendingEvents = 0;

  for (const event of events) {
    if (Date.parse(event.createdAt) < cutoff) continue;
    totalPi += event.amountPi;
    if (event.migrationNumber === 1) firstEvents++;
    if (event.migrationNumber === 2) secondEvents++;
    if (event.migrationNumber == null) pendingEvents++;

    const row = wallets.get(event.address) || {
      address: event.address,
      amountPi: 0,
      eventCount: 0,
      balanceCount: 0,
      first: false,
      second: false,
      later: false,
      pending: false,
      latestAt: null,
      tranches: [],
    };
    row.amountPi += event.amountPi;
    row.eventCount++;
    row.balanceCount += event.balanceCount;
    row.first ||= event.migrationNumber === 1;
    row.second ||= event.migrationNumber === 2;
    row.later ||= event.migrationNumber > 2;
    row.pending ||= event.migrationNumber == null;
    row.tranches.push(...(event.tranches || []).map(tranche => ({
      ...tranche,
      migrationNumber: event.migrationNumber,
      createdAt: event.createdAt,
    })));
    if (!row.latestAt || event.createdAt > row.latestAt) row.latestAt = event.createdAt;
    wallets.set(event.address, row);
  }

  const ranking = [...wallets.values()]
    .sort((a, b) => b.amountPi - a.amountPi || a.address.localeCompare(b.address))
    .slice(0, 20)
    .map((row, index) => ({
      rank: index + 1,
      address: row.address,
      amountPi: +row.amountPi.toFixed(7),
      migrationType: row.first && row.second
        ? '1st & 2nd'
        : row.second
          ? '2nd'
          : row.later
            ? 'later'
            : row.first
              ? '1st'
              : 'awaiting classification',
      eventCount: row.eventCount,
      balanceCount: row.balanceCount,
      latestAt: row.latestAt,
      tranches: row.tranches.sort((a, b) =>
        (a.migrationNumber || 99) - (b.migrationNumber || 99)
        || Number(a.lockSeconds || 0) - Number(b.lockSeconds || 0)),
    }));

  return {
    cutoff: new Date(cutoff).toISOString(),
    totalPi: +totalPi.toFixed(7),
    walletCount: wallets.size,
    firstEvents,
    secondEvents,
    pendingEvents,
    ranking,
  };
}

function migrationAverages(now = Date.now(), events = classifyRecentEvents()) {
  const cutoff = now - RECENT_RETENTION_MS;
  const first = { events: 0, totalPi: 0, amounts: [] };
  const second = { events: 0, totalPi: 0, amounts: [] };
  let totalEvents = 0;
  for (const event of events) {
    if (Date.parse(event.createdAt) < cutoff) continue;
    totalEvents++;
    const bucket = event.migrationNumber === 1 ? first : event.migrationNumber === 2 ? second : null;
    if (!bucket) continue;
    const amount = Number(event.amountPi || 0);
    bucket.events++;
    bucket.totalPi += amount;
    bucket.amounts.push(amount);
  }
  const finish = bucket => {
    const sorted = bucket.amounts.sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length
      ? sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2
      : null;
    return {
      events: bucket.events,
      totalPi: +bucket.totalPi.toFixed(7),
      averagePi: bucket.events ? +(bucket.totalPi / bucket.events).toFixed(7) : null,
      medianPi: median == null ? null : +median.toFixed(7),
    };
  };
  const classifiedEvents = first.events + second.events;
  const sources = { createAccount: 0, index: 0, inferred: 0 };
  for (const event of events) {
    if (Date.parse(event.createdAt) < cutoff) continue;
    if (event.classifiedBy === 'create_account') sources.createAccount++;
    else if (event.classifiedBy === 'index') sources.index++;
    else if (event.classifiedBy === 'inferred') sources.inferred++;
  }
  return {
    days: Math.round(RECENT_RETENTION_MS / 86400000),
    from: new Date(cutoff).toISOString(),
    to: new Date(now).toISOString(),
    first: finish(first),
    second: finish(second),
    classification: {
      totalEvents,
      classifiedEvents,
      pendingEvents: Math.max(0, totalEvents - classifiedEvents),
      coveragePercent: totalEvents ? +(classifiedEvents / totalEvents * 100).toFixed(2) : 0,
      // Verificado = sinal on-chain direto ou hash conhecido pelo índice.
      // O restante é inferência e não conta aqui.
      verifiedEvents: sources.createAccount + sources.index,
      inferredEvents: sources.inferred,
      verifiedPercent: totalEvents
        ? +((sources.createAccount + sources.index) / totalEvents * 100).toFixed(2)
        : 0,
      sources,
    },
  };
}

function migrationInsights(now = Date.now(), events = classifyRecentEvents()) {
  const cutoff = now - RECENT_RETENTION_MS;
  const cutoff24h = now - 86400000;
  const typeBucket = () => ({ first: { lockups: 0, totalPi: 0 }, second: { lockups: 0, totalPi: 0 } });
  const lockups = {
    upTo30Days: typeBucket(),
    oneToSixMonths: typeBucket(),
    sixToTwelveMonths: typeBucket(),
    overOneYear: typeBucket(),
    unknown: typeBucket(),
  };
  const sizes = {
    under100: { first: 0, second: 0 },
    from100To1000: { first: 0, second: 0 },
    from1000To10000: { first: 0, second: 0 },
    over10000: { first: 0, second: 0 },
  };
  const totals = {
    first: { events: 0, totalPi: 0 },
    second: { events: 0, totalPi: 0 },
  };
  const largest24h = { first: null, second: null };

  for (const event of events) {
    const eventTime = Date.parse(event.createdAt);
    if (eventTime < cutoff) continue;
    const type = event.migrationNumber === 1 ? 'first' : event.migrationNumber === 2 ? 'second' : null;
    if (!type) continue;
    const amount = Number(event.amountPi || 0);
    totals[type].events++;
    totals[type].totalPi += amount;

    const sizeKey = amount < 100
      ? 'under100'
      : amount < 1000
        ? 'from100To1000'
        : amount < 10000
          ? 'from1000To10000'
          : 'over10000';
    sizes[sizeKey][type]++;

    for (const tranche of event.tranches || []) {
      const seconds = Number(tranche.lockSeconds);
      const lockKey = tranche.lockSeconds == null || !Number.isFinite(seconds)
        ? 'unknown'
        : seconds <= 30 * 86400
          ? 'upTo30Days'
          : seconds <= 183 * 86400
            ? 'oneToSixMonths'
            : seconds <= 365 * 86400
              ? 'sixToTwelveMonths'
              : 'overOneYear';
      lockups[lockKey][type].lockups++;
      lockups[lockKey][type].totalPi += Number(tranche.amountPi || 0);
    }

    if (eventTime >= cutoff24h && (!largest24h[type] || amount > largest24h[type].amountPi)) {
      largest24h[type] = {
        address: event.address,
        transactionHash: event.transactionHash,
        createdAt: event.createdAt,
        amountPi: +amount.toFixed(7),
        balanceCount: Number(event.balanceCount || 0),
        migrationNumber: event.migrationNumber,
      };
    }
  }

  for (const bucket of Object.values(lockups)) {
    bucket.first.totalPi = +bucket.first.totalPi.toFixed(7);
    bucket.second.totalPi = +bucket.second.totalPi.toFixed(7);
  }
  totals.first.totalPi = +totals.first.totalPi.toFixed(7);
  totals.second.totalPi = +totals.second.totalPi.toFixed(7);
  const classifiedEvents = totals.first.events + totals.second.events;
  const classifiedPi = totals.first.totalPi + totals.second.totalPi;

  return {
    days: Math.round(RECENT_RETENTION_MS / 86400000),
    lockupDistribution: lockups,
    sizeDistribution: sizes,
    secondMigrationShare: {
      eventsPercent: classifiedEvents ? +(totals.second.events / classifiedEvents * 100).toFixed(2) : 0,
      volumePercent: classifiedPi ? +(totals.second.totalPi / classifiedPi * 100).toFixed(2) : 0,
      firstEvents: totals.first.events,
      secondEvents: totals.second.events,
      firstPi: totals.first.totalPi,
      secondPi: totals.second.totalPi,
    },
    largest24h,
  };
}

function buildReport({ complete }) {
  const now = Date.now();
  pruneRecentEvents(now);
  const destinationEntries = Object.entries(state.byDest);
  const entries = destinationEntries.map(([, entry]) => entry);
  const recent = classifyRecentEvents();
  const firstAddresses=new Set(destinationEntries.map(([address])=>address));
  for(const event of recent)if(event.migrationNumber===1)firstAddresses.add(event.address);
  const secondAddresses = new Set(
    destinationEntries.filter(([, entry]) => entry.secondTx).map(([address]) => address),
  );
  const second24hAddresses = new Set(
    destinationEntries
      .filter(([, entry]) => entry.secondAt && Date.parse(entry.secondAt) >= now - 86400000)
      .map(([address]) => address),
  );
  const second7dAddresses = new Set(
    destinationEntries
      .filter(([, entry]) => entry.secondAt && Date.parse(entry.secondAt) >= now - WEEK_MS)
      .map(([address]) => address),
  );
  for (const event of recent) {
    if (event.migrationNumber !== 2) continue;
    secondAddresses.add(event.address);
    const eventTime = Date.parse(event.createdAt);
    if (eventTime >= now - 86400000) second24hAddresses.add(event.address);
    if (eventTime >= now - WEEK_MS) second7dAddresses.add(event.address);
  }
  const receivedSecond = secondAddresses.size;
  const historicalLatestSecondAt = entries.reduce(
    (latest, entry) => entry.secondAt && (!latest || entry.secondAt > latest) ? entry.secondAt : latest,
    null,
  );
  const latestSecondAt = recent.reduce(
    (latest, event) => event.migrationNumber === 2 && (!latest || event.createdAt > latest)
      ? event.createdAt
      : latest,
    historicalLatestSecondAt,
  );
  const week = weeklyMetrics(now, recent);
  const averages = migrationAverages(now, recent);
  const insights = migrationInsights(now, recent);

  return {
    schemaVersion: 14,
    wallet: WALLET,
    generatedAt: new Date(now).toISOString(),
    complete,
    cursor: state.cursor,
    indexCoverageFrom: state.coverageFrom,
    skipHistory: SKIP_HISTORY,
    pagesScanned: state.pages,
    recordsScanned: state.scannedRecords,
    claimableBalancesScanned: state.claimableBalances,
    firstMigrationsDetected: firstAddresses.size,
    receivedSecondMigration: receivedSecond,
    onlyFirst: Math.max(0, firstAddresses.size - receivedSecond),
    secondMigrationLast24h: second24hAddresses.size,
    secondMigrationLast7d: second7dAddresses.size,
    latestSecondMigrationAt: latestSecondAt,
    uniqueMigrationRecipients: entries.length,
    daily: dailySeries(14, recent),
    migrationAverages: averages,
    migrationInsights: insights,
    weekly: {
      from: week.cutoff,
      to: new Date(now).toISOString(),
      totalPi: week.totalPi,
      walletCount: week.walletCount,
      firstMigrationEvents: week.firstEvents,
      secondMigrationEvents: week.secondEvents,
      pendingClassificationEvents: week.pendingEvents,
    },
    weeklyMigrationRanking: week.ranking,
    recentScan: state.recentScan,
    storage: {
      d1Ready: d1Enabled && state.d1Ready === true,
      error: d1Error,
      d1SeedInProgress: d1Enabled && state.d1Ready !== true,
    },
    detection: {
      rule: 'one recipient plus one distinct transaction_hash equals one migration event',
      sourceOperation: 'create_claimable_balance',
      firstMigrationSignal: 'create_account for the same recipient in the same transaction',
      secondMigrationInference: INFER_SECOND
        ? 'no create_account in the transaction means the account already existed, so the event is a second migration'
        : 'disabled',
      recoveryWallet: RECOVERY_WALLET,
      timezone: 'UTC',
    },
    uniqueRecipients: entries.length,
    totalPayments: state.claimableBalances,
  };
}

function writeReport(options) {
  const stats = buildReport(options);
  writeFileSync(OUT, JSON.stringify(stats, null, 2));
  return stats;
}

async function pushReport(stats) {
  if (!PUSH_URL) return;
  const response = await fetch(PUSH_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${PUSH_TOKEN}`,
    },
    body: JSON.stringify(stats),
  });
  if (!response.ok) throw new Error(`Worker HTTP ${response.status}: ${await response.text()}`);
  console.log('Resultado enviado ao Worker ✓');
}

async function publishProgress(complete = false) {
  const stats = writeReport({ complete });
  if (!PUSH_URL) return stats;
  try {
    await pushReport(stats);
  } catch (error) {
    console.log(`Aviso: não foi possível publicar o progresso (${error.message}).`);
  }
  return stats;
}

function printSummary(stats) {
  console.log('\n===== RESULTADO =====');
  console.log(`Carteiras com 1ª migração: ${stats.firstMigrationsDetected.toLocaleString('pt-BR')}`);
  console.log(`Carteiras com 2ª migração: ${stats.receivedSecondMigration.toLocaleString('pt-BR')}`);
  console.log(`2ªs migrações em 7 dias:   ${stats.secondMigrationLast7d.toLocaleString('pt-BR')}`);
  console.log(`Pi migrado em 7 dias:      ${stats.weekly.totalPi.toLocaleString('pt-BR', { maximumFractionDigits: 7 })}`);
  console.log(`Registros examinados:      ${stats.recordsScanned.toLocaleString('pt-BR')}`);
  console.log(stats.complete ? 'Índice sincronizado com o Horizon.' : 'Índice parcial; continue pelo checkpoint.');
}

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n${signal}: salvando checkpoint…`);
  saveCheckpoint();
  await publishProgress(false);
  process.exit(0);
}
process.on('SIGINT', () => { void stop('SIGINT'); });
process.on('SIGTERM', () => { void stop('SIGTERM'); });

(async () => {
  console.log(`Carteira de migração: ${WALLET}`);
  console.log('Fonte: operações create_claimable_balance agrupadas por destinatário e transação.\n');

  await restoreFromD1();
  await refreshRecentEvents();
  saveCheckpoint();
  await publishProgress(false);

  const seedFinished = await seedD1();
  if (!seedFinished) {
    saveCheckpoint();
    await publishProgress(false);
    if (d1Paused) {
      console.log('Cópia para o D1 incompleta por cota; ela continua no próximo run.');
      printSummary(await publishProgress(false));
      return;
    }
    console.log('A classificação histórica continuará enquanto o D1 é preenchido.');
  }

  let pagesThisRun = 0;
  if (SKIP_HISTORY && await jumpToPresent()) {
    saveCheckpoint();
    if (d1Enabled && state.d1Ready) await syncD1Wallets([], d1Meta(false));
  }
  let complete = false;
  while (!MAX_PAGES || pagesThisRun < MAX_PAGES) {
    if(Date.now()-Date.parse(state.recentScan?.completedAt||0)>15*60000){
      await refreshRecentEvents();await publishProgress(false);
    }
    const page = await getPage(state.cursor);
    const records = page._embedded?.records || [];
    if (records.length === 0) {
      complete = true;
      break;
    }
    const changedAddresses = new Set();
    for (const operation of records) {
      const address = record(operation);
      if (address) changedAddresses.add(address);
    }
    state.cursor = records.at(-1).paging_token;
    state.pages++;
    pagesThisRun++;

    if (d1Enabled && state.d1Ready) {
      try {
        await syncD1Wallets([...changedAddresses].map(walletSnapshot), d1Meta(false));
      } catch (error) {
        console.log(`Aviso: D1 perdeu a sincronização (${error.message}); será recopiado.`);
        state.d1Ready = false;
        state.d1SeedOffset = 0;
        d1Enabled = false;
        d1Error = error.message;
        saveCheckpoint();
        await publishProgress(false);
        break;
      }
    }

    if (d1Paused) {
      // Evita que o cursor local se afaste do D1 enquanto a cota está esgotada.
      console.log('Interrompendo o avanço histórico até a cota do D1 renovar.');
      saveCheckpoint();
      break;
    }

    if (state.pages % CHECKPOINT_EVERY === 0) {
      saveCheckpoint();
      const entries = Object.values(state.byDest);
      console.log(
        `Página ${state.pages.toLocaleString('pt-BR')} · `
        + `${entries.length.toLocaleString('pt-BR')} carteiras · `
        + `${entries.filter(entry => entry.secondTx).length.toLocaleString('pt-BR')} com 2ª migração`,
      );
    }
    if (state.pages % PUSH_EVERY_PAGES === 0) {
      console.log('Publicando progresso parcial…');
      await publishProgress(false);
    }
    await sleep(THROTTLE_MS);
  }

  saveCheckpoint();
  if (d1Enabled && state.d1Ready) await syncD1Wallets([], d1Meta(complete));
  const stats = await publishProgress(complete);
  printSummary(stats);
})().catch(async error => {
  const quota = isQuotaError(error.message);
  console[quota ? 'log' : 'error'](quota ? `D1 sem cota diária: ${error.message}` : `ERRO: ${error.message}`);
  saveCheckpoint();
  await publishProgress(false);
  // Cota esgotada é limite de plano, não erro do crawler: o checkpoint está salvo.
  process.exit(quota ? 0 : 1);
});
