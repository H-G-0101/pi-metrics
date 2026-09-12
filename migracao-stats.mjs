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
  readFileSync,
  renameSync,
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
const PUSH_URL = process.env.PUSH_URL || '';
const PUSH_TOKEN = process.env.PUSH_TOKEN || '';
const WORKER_BASE = process.env.WORKER_BASE
  || PUSH_URL.replace(/\/stats(?:\?.*)?$/, '');
const D1_SYNC_URL = WORKER_BASE ? `${WORKER_BASE}/d1/sync` : '';
const D1_RESTORE_URL = WORKER_BASE ? `${WORKER_BASE}/d1/restore` : '';
const D1_SEED_LIMIT = Math.max(100, Number(process.env.D1_SEED_LIMIT || 15000));
const D1_BATCH_SIZE = 32;
const CK = process.env.CHECKPOINT_FILE || './checkpoint.json';
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
    recentScan: null,
    lastSeenAt: null,
    d1Ready: false,
    d1SeedOffset: 0,
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
      checkpointLoaded = true;
      saved.recentEvents ||= {};
      saved.recentScan ||= null;
      saved.d1Ready ||= false;
      saved.d1SeedOffset = Number(saved.d1SeedOffset || 0);
      return saved;
    }
    console.log('Checkpoint antigo ou incompatível; iniciando o índice correto do zero.');
  } catch (error) {
    console.log(`Checkpoint inválido (${error.message}); iniciando do zero.`);
  }
  return emptyState();
}

let state = loadState();
let d1Enabled = Boolean(D1_SYNC_URL && D1_RESTORE_URL && PUSH_TOKEN);

function d1Meta(complete = false) {
  return {
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
  if (!rows.length) {
    if (meta) await callD1(D1_SYNC_URL, { method: 'POST', body: JSON.stringify({ wallets: [], meta }) });
    return;
  }
  for (let index = 0; index < rows.length; index += D1_BATCH_SIZE) {
    const chunk = rows.slice(index, index + D1_BATCH_SIZE);
    const isLast = index + D1_BATCH_SIZE >= rows.length;
    await callD1(D1_SYNC_URL, {
      method: 'POST',
      body: JSON.stringify({ wallets: chunk, meta: isLast ? meta : null }),
    });
  }
}

async function restoreFromD1() {
  if (!d1Enabled || checkpointLoaded) return false;
  try {
    let after = '';
    let restored = 0;
    let meta = null;
    do {
      const url = `${D1_RESTORE_URL}?after=${encodeURIComponent(after)}`;
      const data = await callD1(url);
      meta ||= data.meta;
      if (!meta) return false;
      for (const row of data.wallets || []) {
        state.byDest[row.address] = {
          firstTx: row.firstTx,
          firstAt: row.firstAt,
          secondTx: row.secondTx,
          secondAt: row.secondAt,
          lastTx: row.lastTx,
          eventCount: Number(row.eventCount || 1),
        };
        after = row.address;
        restored++;
      }
      if (!(data.wallets || []).length || !data.hasMore) break;
    } while (true);

    state.cursor = meta.cursor || '';
    state.pages = Number(meta.pages || 0);
    state.scannedRecords = Number(meta.scannedRecords || 0);
    state.claimableBalances = Number(meta.claimableBalances || 0);
    state.lastSeenAt = meta.lastSeenAt || null;
    state.d1Ready = true;
    state.d1SeedOffset = 0;
    console.log(`Índice restaurado do D1: ${restored.toLocaleString('pt-BR')} carteiras.`);
    return true;
  } catch (error) {
    console.log(`Aviso: restauração D1 indisponível (${error.message}).`);
    d1Enabled = false;
    return false;
  }
}

async function seedD1() {
  if (!d1Enabled || state.d1Ready) return true;
  const addresses = Object.keys(state.byDest);
  const start = Math.min(state.d1SeedOffset, addresses.length);
  const selected = addresses.slice(start, start + D1_SEED_LIMIT);
  try {
    for (let index = 0; index < selected.length; index += D1_BATCH_SIZE) {
      const group = selected.slice(index, index + D1_BATCH_SIZE).map(walletSnapshot);
      await syncD1Wallets(group);
      state.d1SeedOffset = start + Math.min(index + D1_BATCH_SIZE, selected.length);
    }
    if (state.d1SeedOffset < addresses.length) {
      console.log(
        `D1 recebeu mais ${selected.length.toLocaleString('pt-BR')} carteiras; `
        + 'a cópia continuará em paralelo na próxima execução.',
      );
      return false;
    }
    state.d1Ready = true;
    state.d1SeedOffset = 0;
    await syncD1Wallets([], d1Meta(false));
    console.log('Cópia inicial do índice no D1 concluída ✓');
    return true;
  } catch (error) {
    console.log(`Aviso: sincronização D1 indisponível (${error.message}).`);
    d1Enabled = false;
    return true;
  }
}

async function getPage(cursor, order = 'asc') {
  const url = `${HORIZON}/accounts/${WALLET}/operations`
    + `?order=${order}&limit=${PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;

  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
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

function migrationDestination(operation) {
  if (operation.type !== 'create_claimable_balance' || operation.source_account !== WALLET) {
    return null;
  }
  const claimants = operation.claimants || [];
  const recipient = claimants.find(claimant =>
    claimant.destination
    && claimant.destination !== RECOVERY_WALLET
    && claimant.destination !== WALLET
  );
  return recipient?.destination || null;
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
  });
  event.amountPi += Number(operation.amount || 0);
  event.balanceCount++;
}

async function refreshRecentEvents() {
  const cutoff = Date.now() - RECENT_RETENTION_MS;
  let cursor = '';
  let pages = 0;

  state.recentEvents = {};
  state.recentScan = {
    complete: false,
    pages: 0,
    newestAt: null,
    oldestAt: null,
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
  console.log(
    `Janela recente pronta: ${Object.keys(state.recentEvents).length.toLocaleString('pt-BR')} eventos em `
    + `${pages.toLocaleString('pt-BR')} páginas.`,
  );
}

function pruneRecentEvents(now = Date.now()) {
  const cutoff = now - RECENT_RETENTION_MS;
  for (const [key, event] of Object.entries(state.recentEvents)) {
    if (Date.parse(event.createdAt) < cutoff) delete state.recentEvents[key];
  }
}

function saveCheckpoint() {
  pruneRecentEvents();
  const temp = `${CK}.tmp`;
  writeFileSync(temp, JSON.stringify(state));
  renameSync(temp, CK);
}

function classifyRecentEvents() {
  const rows = Object.values(state.recentEvents)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const inferredByAddress = new Map();

  return rows.map(event => {
    const entry = state.byDest[event.address];
    let migrationNumber = null;
    if (entry?.firstTx === event.transactionHash) migrationNumber = 1;
    else if (entry?.secondTx === event.transactionHash) migrationNumber = 2;
    else if (entry?.lastTx === event.transactionHash) migrationNumber = entry.eventCount;
    else if (entry && state.lastSeenAt && event.createdAt > state.lastSeenAt) {
      const offset = (inferredByAddress.get(event.address) || 0) + 1;
      inferredByAddress.set(event.address, offset);
      migrationNumber = entry.eventCount + offset;
    }
    return { ...event, migrationNumber };
  });
}

function dailySeries(days = 14) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const rows = [];
  const byDate = new Map();
  for (let offset = days - 1; offset >= 0; offset--) {
    const date = new Date(today.getTime() - offset * 86400000).toISOString().slice(0, 10);
    const row = { date, first: 0, second: 0, pending: 0 };
    rows.push(row);
    byDate.set(date, row);
  }
  for (const event of classifyRecentEvents()) {
    const row = byDate.get(event.createdAt?.slice(0, 10));
    if (!row) continue;
    if (event.migrationNumber === 1) row.first++;
    else if (event.migrationNumber === 2) row.second++;
    else row.pending++;
  }
  return rows;
}

function weeklyMetrics(now = Date.now()) {
  const cutoff = now - WEEK_MS;
  const wallets = new Map();
  let totalPi = 0;
  let firstEvents = 0;
  let secondEvents = 0;
  let pendingEvents = 0;

  for (const event of classifyRecentEvents()) {
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
    };
    row.amountPi += event.amountPi;
    row.eventCount++;
    row.balanceCount += event.balanceCount;
    row.first ||= event.migrationNumber === 1;
    row.second ||= event.migrationNumber === 2;
    row.later ||= event.migrationNumber > 2;
    row.pending ||= event.migrationNumber == null;
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
        ? '1ª e 2ª'
        : row.second
          ? '2ª'
          : row.later
            ? 'posterior'
            : row.first
              ? '1ª'
              : 'em análise',
      eventCount: row.eventCount,
      balanceCount: row.balanceCount,
      latestAt: row.latestAt,
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

function buildReport({ complete }) {
  const now = Date.now();
  pruneRecentEvents(now);
  const destinationEntries = Object.entries(state.byDest);
  const entries = destinationEntries.map(([, entry]) => entry);
  const recent = classifyRecentEvents();
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
  const week = weeklyMetrics(now);

  return {
    schemaVersion: 6,
    wallet: WALLET,
    generatedAt: new Date(now).toISOString(),
    complete,
    cursor: state.cursor,
    pagesScanned: state.pages,
    recordsScanned: state.scannedRecords,
    claimableBalancesScanned: state.claimableBalances,
    firstMigrationsDetected: entries.length,
    receivedSecondMigration: receivedSecond,
    onlyFirst: Math.max(0, entries.length - receivedSecond),
    secondMigrationLast24h: second24hAddresses.size,
    secondMigrationLast7d: second7dAddresses.size,
    latestSecondMigrationAt: latestSecondAt,
    uniqueMigrationRecipients: entries.length,
    daily: dailySeries(14),
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
      d1Ready: state.d1Ready === true,
      d1SeedInProgress: d1Enabled && state.d1Ready !== true,
    },
    detection: {
      rule: 'one recipient plus one distinct transaction_hash equals one migration event',
      sourceOperation: 'create_claimable_balance',
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
    console.log('A classificação histórica continuará enquanto o D1 é preenchido.');
  }

  let pagesThisRun = 0;
  let complete = false;
  while (!MAX_PAGES || pagesThisRun < MAX_PAGES) {
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
      }
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
})().catch(error => {
  console.error('ERRO:', error.message);
  saveCheckpoint();
  writeReport({ complete: false });
  process.exit(1);
});
