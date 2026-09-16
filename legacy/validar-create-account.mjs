#!/usr/bin/env node
/**
 * Valida a hipótese: "evento SEM create_account na mesma transação é uma
 * migração posterior à primeira (2ª+)".
 *
 * Método: pega eventos recentes de migração, e para cada carteira busca a
 * PRIMEIRA operação da conta no Horizon (order=asc). Se a conta foi criada
 * pela carteira de migração no mesmo hash do evento, o evento é 1ª migração.
 * Se a conta já existia antes do evento, o evento é 2ª ou posterior.
 *
 * Uso:
 *   node validar-create-account.mjs            # 25 carteiras
 *   SAMPLE=60 node validar-create-account.mjs  # amostra maior
 */

const HORIZON = process.env.HORIZON || 'https://api.mainnet.minepi.com';
const WALLET = process.env.WALLET || 'GABT7EMPGNCQSZM22DIYC4FNKHUVJTXITUF6Y5HNIWPU4GA7BHT4GC5G';
const RECOVERY_WALLET = process.env.RECOVERY_WALLET
  || 'GC5RNDCRO6DDM7NZDEMW3RIN5K6AHN6GMWSZ5SAH2TRJLVGQMB2I3BNJ';
const SAMPLE = Math.max(5, Number(process.env.SAMPLE || 25));
const PAGES = Math.max(1, Number(process.env.PAGES || 6));

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(path) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(HORIZON + path, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
    if (response.status === 429 || response.status >= 500) {
      if (attempt > 5) throw new Error(`Horizon ${response.status}`);
      await sleep(Math.min(30000, 2000 * 2 ** attempt));
      continue;
    }
    if (!response.ok) throw new Error(`Horizon ${response.status} em ${path}`);
    return response.json();
  }
}

function destination(operation) {
  if (operation.type !== 'create_claimable_balance' || operation.source_account !== WALLET) return null;
  return (operation.claimants || []).find(claimant =>
    claimant.destination
    && claimant.destination !== RECOVERY_WALLET
    && claimant.destination !== WALLET
  )?.destination || null;
}

// Coleta eventos recentes e marca quais têm create_account no mesmo hash.
async function collectEvents() {
  const events = new Map();
  const createdKeys = new Set();
  let cursor = '';
  for (let page = 0; page < PAGES; page++) {
    const data = await get(`/accounts/${WALLET}/operations?order=desc&limit=200${cursor ? `&cursor=${cursor}` : ''}`);
    const records = data._embedded?.records || [];
    if (!records.length) break;
    for (const operation of records) {
      if (operation.type === 'create_account' && operation.source_account === WALLET && operation.account) {
        createdKeys.add(`${operation.transaction_hash}:${operation.account}`);
      }
      const address = destination(operation);
      if (!address || !operation.transaction_hash) continue;
      const key = `${address}:${operation.transaction_hash}`;
      if (!events.has(key)) {
        events.set(key, { address, hash: operation.transaction_hash, createdAt: operation.created_at });
      }
    }
    cursor = records.at(-1).paging_token;
    await sleep(60);
  }
  for (const event of events.values()) {
    event.hasCreateAccount = createdKeys.has(`${event.hash}:${event.address}`);
  }
  return [...events.values()];
}

// Verdade de campo: a conta foi criada nesta mesma transação?
async function checkWallet(event) {
  const data = await get(`/accounts/${event.address}/operations?order=asc&limit=1`);
  const first = (data._embedded?.records || [])[0];
  if (!first) return { ...event, verdict: 'sem histórico' };
  const createdHere = first.type === 'create_account' && first.transaction_hash === event.hash;
  const accountOlder = Date.parse(first.created_at) < Date.parse(event.createdAt);
  return {
    ...event,
    accountCreatedAt: first.created_at,
    truth: createdHere ? 1 : (accountOlder ? 2 : 1),
    createdByMigration: first.type === 'create_account' && first.source_account === WALLET,
  };
}

(async () => {
  console.log(`Carteira: ${WALLET}`);
  console.log(`Coletando eventos recentes (${PAGES} páginas)…`);
  const events = await collectEvents();
  if (!events.length) return console.log('Nenhum evento de migração encontrado nas páginas lidas.');

  // Amostra equilibrada entre os dois grupos.
  const withSignal = events.filter(event => event.hasCreateAccount);
  const withoutSignal = events.filter(event => !event.hasCreateAccount);
  console.log(`${events.length} eventos · ${withSignal.length} com create_account · ${withoutSignal.length} sem\n`);

  const pick = (list, n) => list.sort(() => Math.random() - 0.5).slice(0, n);
  const sample = [...pick(withSignal, Math.ceil(SAMPLE / 2)), ...pick(withoutSignal, Math.ceil(SAMPLE / 2))];

  const results = [];
  for (const event of sample) {
    try {
      results.push(await checkWallet(event));
    } catch (error) {
      console.log(`  ↳ falha em ${event.address.slice(0, 8)}…: ${error.message}`);
    }
    await sleep(80);
  }

  let acertos = 0;
  let erros = 0;
  const falhas = [];
  for (const row of results) {
    if (!row.truth) continue;
    const previsto = row.hasCreateAccount ? 1 : 2;
    if (previsto === row.truth) acertos++;
    else { erros++; falhas.push(row); }
  }

  const total = acertos + erros;
  console.log('\n===== RESULTADO =====');
  console.log(`Amostra verificada:   ${total}`);
  console.log(`Regra acertou:        ${acertos} (${total ? (acertos / total * 100).toFixed(1) : 0}%)`);
  console.log(`Regra errou:          ${erros}`);
  if (falhas.length) {
    console.log('\nCasos em que a regra falhou:');
    for (const row of falhas.slice(0, 10)) {
      console.log(`  ${row.address}`);
      console.log(`    evento ${row.createdAt} · create_account no hash: ${row.hasCreateAccount}`);
      console.log(`    conta criada em ${row.accountCreatedAt} (pela carteira de migração: ${row.createdByMigration})`);
    }
  }
  console.log(
    erros === 0
      ? '\nHipótese confirmada nesta amostra: sem create_account = migração posterior à 1ª.'
      : '\nHipótese com exceções: use o índice histórico para os casos ambíguos.',
  );
})().catch(error => {
  console.error('ERRO:', error.message);
  process.exit(1);
});
