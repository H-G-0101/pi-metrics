#!/usr/bin/env node
/**
 * Métricas de 1ª e 2ª migração da Pi Network.
 *
 * A carteira de distribuição usa duas assinaturas observáveis no endpoint
 * /payments do Horizon:
 *   - 1ª migração: create_account financiado pela carteira;
 *   - 2ª migração: payment nativo de 0,02 Pi para uma conta já existente.
 *
 * O checkpoint guarda somente um registro por destinatário, o que permite
 * continuar o crawl sem duplicar pessoas entre páginas ou execuções.
 */

import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';

const HORIZON = process.env.HORIZON || 'https://api.mainnet.minepi.com';
const WALLET = process.env.WALLET || 'GABT7EMPGNCQSZM22DIYC4FNKHUVJTXITUF6Y5HNIWPU4GA7BHT4GC5G';
const SECOND_MARKER_AMOUNT = process.env.SECOND_MARKER_AMOUNT || '0.0200000';

const PAGE_LIMIT = Math.min(200, Math.max(1, Number(process.env.PAGE_LIMIT || 200)));
const CHECKPOINT_EVERY = Math.max(1, Number(process.env.CHECKPOINT_EVERY || 25));
const THROTTLE_MS = Math.max(0, Number(process.env.THROTTLE_MS || 120));
const MAX_PAGES = Math.max(0, Number(process.env.MAX_PAGES || 0)); // 0 = sem limite
const PUSH_URL = process.env.PUSH_URL || '';
const PUSH_TOKEN = process.env.PUSH_TOKEN || '';

const CK = process.env.CHECKPOINT_FILE || './checkpoint.json';
const OUT = process.env.OUTPUT_FILE || './migracao-stats.json';
const STATE_VERSION = 2;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function emptyState() {
  return {
    version: STATE_VERSION,
    wallet: WALLET,
    markerAmount: SECOND_MARKER_AMOUNT,
    cursor: '',
    pages: 0,
    scannedRecords: 0,
    firstByDest: {},
    secondByDest: {},
    lastSeenAt: null,
  };
}

function loadState() {
  if (!existsSync(CK)) return emptyState();
  try {
    const saved = JSON.parse(readFileSync(CK, 'utf8'));
    const compatible = saved.version === STATE_VERSION
      && saved.wallet === WALLET
      && saved.markerAmount === SECOND_MARKER_AMOUNT;
    if (compatible) return saved;
    console.log('Checkpoint antigo ou de outra configuração; iniciando um crawl completo.');
  } catch (error) {
    console.log(`Checkpoint inválido (${error.message}); iniciando um crawl completo.`);
  }
  return emptyState();
}

let state = loadState();

async function getPage(cursor) {
  const url = `${HORIZON}/accounts/${WALLET}/payments`
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

function isNativeSecondMarker(operation) {
  return operation.type === 'payment'
    && operation.from === WALLET
    && operation.asset_type === 'native'
    && Number(operation.amount) === Number(SECOND_MARKER_AMOUNT);
}

function record(operation) {
  state.scannedRecords++;
  if (operation.created_at) state.lastSeenAt = operation.created_at;

  if (operation.type === 'create_account' && operation.funder === WALLET && operation.account) {
    state.firstByDest[operation.account] ||= operation.created_at;
    return;
  }

  if (isNativeSecondMarker(operation) && operation.to) {
    state.secondByDest[operation.to] ||= operation.created_at;
  }
}

function saveCheckpoint() {
  const temp = `${CK}.tmp`;
  writeFileSync(temp, JSON.stringify(state));
  renameSync(temp, CK);
}

function countSince(entries, sinceMs) {
  let total = 0;
  for (const iso of Object.values(entries)) {
    if (Date.parse(iso) >= sinceMs) total++;
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

  for (const iso of Object.values(state.firstByDest)) {
    const row = byDate.get(iso?.slice(0, 10));
    if (row) row.first++;
  }
  for (const iso of Object.values(state.secondByDest)) {
    const row = byDate.get(iso?.slice(0, 10));
    if (row) row.second++;
  }
  return rows;
}

function buildReport({ complete }) {
  const now = Date.now();
  const firstAddresses = Object.keys(state.firstByDest);
  const secondAddresses = Object.keys(state.secondByDest);
  const allAddresses = new Set([...firstAddresses, ...secondAddresses]);
  const firstSet = new Set(firstAddresses);
  const onlyFirst = firstAddresses.reduce((sum, address) => sum + !state.secondByDest[address], 0);
  const secondAfterFirstInThisWallet = secondAddresses.reduce(
    (sum, address) => sum + firstSet.has(address),
    0,
  );
  const latestSecondAt = secondAddresses.reduce((latest, address) => {
    const iso = state.secondByDest[address];
    return !latest || iso > latest ? iso : latest;
  }, null);

  return {
    schemaVersion: 2,
    wallet: WALLET,
    generatedAt: new Date(now).toISOString(),
    complete,
    cursor: state.cursor,
    pagesScanned: state.pages,
    recordsScanned: state.scannedRecords,
    firstMigrationsDetected: firstAddresses.length,
    receivedSecondMigration: secondAddresses.length,
    secondMigrationLast24h: countSince(state.secondByDest, now - 86400000),
    secondMigrationLast7d: countSince(state.secondByDest, now - 7 * 86400000),
    latestSecondMigrationAt: latestSecondAt,
    uniqueMigrationRecipients: allAddresses.size,
    secondAfterFirstInThisWallet,
    onlyFirst,
    daily: dailySeries(14),
    detection: {
      firstMigration: 'create_account funded by the migration wallet',
      secondMigration: `native payment of ${SECOND_MARKER_AMOUNT} Pi from the migration wallet`,
      secondMarkerAmount: SECOND_MARKER_AMOUNT,
      timezone: 'UTC',
    },
    // Campos mantidos para clientes antigos do painel.
    uniqueRecipients: allAddresses.size,
    totalPayments: state.scannedRecords,
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
  if (!response.ok) {
    throw new Error(`Worker respondeu HTTP ${response.status}: ${await response.text()}`);
  }
  console.log('Resultado enviado ao Worker ✓');
}

function printSummary(stats) {
  console.log('\n===== RESULTADO =====');
  console.log(`Primeiras migrações:      ${stats.firstMigrationsDetected.toLocaleString('pt-BR')}`);
  console.log(`Segundas migrações:       ${stats.receivedSecondMigration.toLocaleString('pt-BR')}`);
  console.log(`Segundas nas últimas 24h: ${stats.secondMigrationLast24h.toLocaleString('pt-BR')}`);
  console.log(`Segundas nos últimos 7d:  ${stats.secondMigrationLast7d.toLocaleString('pt-BR')}`);
  console.log(`Registros examinados:     ${stats.recordsScanned.toLocaleString('pt-BR')}`);
  console.log(stats.complete ? 'Crawl alcançou o topo da blockchain.' : 'Amostra parcial; continue pelo checkpoint.');
}

let stopping = false;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n${signal}: salvando checkpoint…`);
  saveCheckpoint();
  writeReport({ complete: false });
  process.exit(0);
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

(async () => {
  console.log(`Carteira: ${WALLET}`);
  console.log(`Marcador da 2ª migração: pagamento nativo de ${SECOND_MARKER_AMOUNT} Pi\n`);

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
      console.log(
        `Página ${state.pages.toLocaleString('pt-BR')} · `
        + `${Object.keys(state.firstByDest).length.toLocaleString('pt-BR')} primeiras · `
        + `${Object.keys(state.secondByDest).length.toLocaleString('pt-BR')} segundas`,
      );
    }
    await sleep(THROTTLE_MS);
  }

  saveCheckpoint();
  const stats = writeReport({ complete });
  printSummary(stats);
  if (complete) await pushReport(stats);
})().catch(error => {
  console.error('ERRO:', error.message);
  saveCheckpoint();
  writeReport({ complete: false });
  process.exit(1);
});
