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
const THROTTLE_MS = Math.max(0, Number(process.env.THROTTLE_MS || 120));
const MAX_PAGES = Math.max(0, Number(process.env.MAX_PAGES || 0));
const PUSH_URL = process.env.PUSH_URL || '';
const PUSH_TOKEN = process.env.PUSH_TOKEN || '';
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
    lastSeenAt: null,
  };
}

function loadState() {
  if (!existsSync(CK)) return emptyState();
  try {
    const saved = JSON.parse(readFileSync(CK, 'utf8'));
    const compatible = saved.version === STATE_VERSION
      && saved.wallet === WALLET
      && saved.recoveryWallet === RECOVERY_WALLET;
    if (compatible) return saved;
    console.log('Checkpoint antigo ou incompatível; iniciando o índice correto do zero.');
  } catch (error) {
    console.log(`Checkpoint inválido (${error.message}); iniciando do zero.`);
  }
  return emptyState();
}

let state = loadState();

async function getPage(cursor) {
  const url = `${HORIZON}/accounts/${WALLET}/operations`
    + `?order=asc&limit=${PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;

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
  if (!address || !operation.transaction_hash) return;

  state.claimableBalances++;
  const entry = state.byDest[address] || (state.byDest[address] = {
    firstTx: null,
    firstAt: null,
    secondTx: null,
    secondAt: null,
    lastTx: null,
    eventCount: 0,
  });
  const number = migrationNumber(entry, operation.transaction_hash, operation.created_at);

  if (Date.parse(operation.created_at) >= Date.now() - RECENT_RETENTION_MS) {
    const key = `${address}:${operation.transaction_hash}`;
    const event = state.recentEvents[key] || (state.recentEvents[key] = {
      address,
      transactionHash: operation.transaction_hash,
      createdAt: operation.created_at,
      migrationNumber: number,
      amountPi: 0,
      balanceCount: 0,
    });
    event.amountPi += Number(operation.amount || 0);
    event.balanceCount++;
  }
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

function countSince(field, sinceMs) {
  let total = 0;
  for (const entry of Object.values(state.byDest)) {
    if (entry[field] && Date.parse(entry[field]) >= sinceMs) total++;
  }
  return total;
}

function dailySeries(days = 14) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const rows = [];
  const byDate = new Map();
  for (let offset = days - 1; offset >= 0; offset--) {
    const date = new Date(today.getTime() - offset * 86400000).toISOString().slice(0, 10);
    const row = { date, first: 0, second: 0 };
    rows.push(row);
    byDate.set(date, row);
  }
  for (const entry of Object.values(state.byDest)) {
    const first = byDate.get(entry.firstAt?.slice(0, 10));
    const second = byDate.get(entry.secondAt?.slice(0, 10));
    if (first) first.first++;
    if (second) second.second++;
  }
  return rows;
}

function weeklyMetrics(now = Date.now()) {
  const cutoff = now - WEEK_MS;
  const wallets = new Map();
  let totalPi = 0;
  let firstEvents = 0;
  let secondEvents = 0;

  for (const event of Object.values(state.recentEvents)) {
    if (Date.parse(event.createdAt) < cutoff) continue;
    totalPi += event.amountPi;
    if (event.migrationNumber === 1) firstEvents++;
    if (event.migrationNumber === 2) secondEvents++;

    const row = wallets.get(event.address) || {
      address: event.address,
      amountPi: 0,
      eventCount: 0,
      balanceCount: 0,
      first: false,
      second: false,
      later: false,
      latestAt: null,
    };
    row.amountPi += event.amountPi;
    row.eventCount++;
    row.balanceCount += event.balanceCount;
    row.first ||= event.migrationNumber === 1;
    row.second ||= event.migrationNumber === 2;
    row.later ||= event.migrationNumber > 2;
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
            : '1ª',
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
    ranking,
  };
}

function buildReport({ complete }) {
  const now = Date.now();
  pruneRecentEvents(now);
  const entries = Object.values(state.byDest);
  const receivedSecond = entries.filter(entry => entry.secondTx).length;
  const latestSecondAt = entries.reduce(
    (latest, entry) => entry.secondAt && (!latest || entry.secondAt > latest) ? entry.secondAt : latest,
    null,
  );
  const week = weeklyMetrics(now);

  return {
    schemaVersion: 3,
    wallet: WALLET,
    generatedAt: new Date(now).toISOString(),
    complete,
    cursor: state.cursor,
    pagesScanned: state.pages,
    recordsScanned: state.scannedRecords,
    claimableBalancesScanned: state.claimableBalances,
    firstMigrationsDetected: entries.length,
    receivedSecondMigration: receivedSecond,
    onlyFirst: entries.length - receivedSecond,
    secondMigrationLast24h: countSince('secondAt', now - 86400000),
    secondMigrationLast7d: countSince('secondAt', now - WEEK_MS),
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
    },
    weeklyMigrationRanking: week.ranking,
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

  let pagesThisRun = 0;
  let complete = false;
  while (!MAX_PAGES || pagesThisRun < MAX_PAGES) {
    const page = await getPage(state.cursor);
    const records = page._embedded?.records || [];
    if (records.length === 0) {
      complete = true;
      break;
    }
    for (const operation of records) record(operation);
    state.cursor = records.at(-1).paging_token;
    state.pages++;
    pagesThisRun++;

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
  const stats = await publishProgress(complete);
  printSummary(stats);
})().catch(error => {
  console.error('ERRO:', error.message);
  saveCheckpoint();
  writeReport({ complete: false });
  process.exit(1);
});
