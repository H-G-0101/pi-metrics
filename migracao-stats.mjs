#!/usr/bin/env node
/**
 * Estatística de migração do Pi Network
 * --------------------------------------
 * Crawleia TODOS os pagamentos enviados por uma carteira de distribuição no
 * Horizon do Pi mainnet e calcula quantos destinatários já receberam a 2ª migração.
 *
 * Rode com:   node migracao-stats.mjs
 * Requer:     Node 18+ (fetch nativo). Sem dependências.
 *
 * É RESUMÍVEL: salva o progresso em checkpoint.json. Se cair (rede, rate limit,
 * ou você der Ctrl+C), é só rodar de novo que ele continua do último cursor.
 */

// ===================== CONFIG =====================
const HORIZON = process.env.HORIZON || 'https://api.mainnet.minepi.com';
const WALLET  = process.env.WALLET || 'GABT7EMPGNCQSZM22DIYC4FNKHUVJTXITUF6Y5HNIWPU4GA7BHT4GC5G';

// Como definir "2ª migração":
//   'count' -> destinatário com >=2 pagamentos já recebeu a 2ª (mais simples)
//   'date'  -> pagamentos a partir de ROUND2_FROM contam como rodada 2
const MODE = process.env.MODE || 'count';
const ROUND2_FROM = '2026-01-01T00:00:00Z';   // usado só no MODE 'date'

const PAGE_LIMIT   = 200;      // máx do Horizon
const CHECKPOINT_EVERY = 25;   // salva a cada N páginas
const THROTTLE_MS  = 120;      // pausa entre páginas (respeita ~3600 req/h)

// Ao terminar, envia o resultado pro seu Worker (deixe PUSH_URL='' pra só gravar o arquivo).
const PUSH_URL   = process.env.PUSH_URL || '';   // ex: https://seu-worker.workers.dev/stats
const PUSH_TOKEN = process.env.PUSH_TOKEN || '';   // o mesmo STATS_TOKEN configurado no Worker
// ==================================================

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const CK = './checkpoint.json';
const OUT = './migracao-stats.json';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Estado agregado — só guardamos contagem por destinatário, não a lista inteira
// de pagamentos (economiza memória mesmo com milhões de registros).
let state = existsSync(CK)
  ? JSON.parse(readFileSync(CK, 'utf8'))
  : { cursor: '', pages: 0, totalPayments: 0,
      // destino -> { n: qtd pagamentos, first: iso, last: iso, r2: recebeu na rodada2 }
      byDest: {} };

async function getPage(cursor) {
  const url = `${HORIZON}/accounts/${WALLET}/payments`
    + `?order=asc&limit=${PAGE_LIMIT}${cursor ? `&cursor=${cursor}` : ''}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (res.status === 429 || res.status >= 500) {          // rate limit / erro servidor
      const wait = Math.min(60000, 2000 * 2 ** attempt);
      console.log(`  ↳ ${res.status}, aguardando ${wait/1000}s…`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${await res.text()}`);
    return res.json();
  }
}

function record(p) {
  // só pagamentos enviados PELA carteira, nativos, com destino
  if (p.type !== 'payment' || p.from !== WALLET || p.asset_type !== 'native') return;
  const d = p.to;
  const e = state.byDest[d] || (state.byDest[d] = { n: 0, first: p.created_at, last: p.created_at, r2: false });
  e.n++;
  e.last = p.created_at;
  if (MODE === 'date' && p.created_at >= ROUND2_FROM) e.r2 = true;
  state.totalPayments++;
}

function save() {
  writeFileSync(CK, JSON.stringify(state));
}

function report() {
  const dests = Object.values(state.byDest);
  const unique = dests.length;

  let gotSecond;
  if (MODE === 'count') gotSecond = dests.filter(e => e.n >= 2).length;
  else                  gotSecond = dests.filter(e => e.r2).length;

  // distribuição de nº de pagamentos por destinatário
  const dist = {};
  for (const e of dests) dist[e.n] = (dist[e.n] || 0) + 1;

  const stats = {
    wallet: WALLET,
    mode: MODE,
    generatedAt: new Date().toISOString(),
    totalPayments: state.totalPayments,
    uniqueRecipients: unique,
    receivedSecondMigration: gotSecond,
    pctSecond: unique ? +(gotSecond / unique * 100).toFixed(2) : 0,
    onlyFirst: unique - gotSecond,
    paymentsPerRecipient: dist,   // ex: {1: 900000, 2: 400000, 3: 1200}
  };
  writeFileSync(OUT, JSON.stringify(stats, null, 2));
  return stats;
  console.log('\n===== RESULTADO =====');
  console.log(`Pagamentos totais:       ${stats.totalPayments.toLocaleString('pt-BR')}`);
  console.log(`Destinatários únicos:    ${stats.uniqueRecipients.toLocaleString('pt-BR')}`);
  console.log(`Receberam a 2ª migração: ${stats.receivedSecondMigration.toLocaleString('pt-BR')} (${stats.pctSecond}%)`);
  console.log(`Só a 1ª (aguardando):    ${stats.onlyFirst.toLocaleString('pt-BR')}`);
  console.log(`\nGravado em ${OUT}`);
}

// Ctrl+C -> salva antes de sair
process.on('SIGINT', () => { console.log('\nSalvando checkpoint…'); save(); process.exit(0); });

(async () => {
  console.log(`Crawleando pagamentos de ${WALLET}\nModo: ${MODE}\n`);
  while (true) {
    const page = await getPage(state.cursor);
    const recs = page._embedded?.records || [];
    if (recs.length === 0) break;                    // fim

    for (const p of recs) record(p);
    state.cursor = recs[recs.length - 1].paging_token;
    state.pages++;

    if (state.pages % CHECKPOINT_EVERY === 0) {
      save();
      console.log(`Página ${state.pages} · ${state.totalPayments.toLocaleString('pt-BR')} pagamentos · ${Object.keys(state.byDest).length.toLocaleString('pt-BR')} destinatários`);
    }
    await sleep(THROTTLE_MS);
  }
  save();
  const stats = report();
  if (PUSH_URL) {
    try {
      const r = await fetch(PUSH_URL, { method:'POST',
        headers:{ 'content-type':'application/json', authorization:'Bearer '+PUSH_TOKEN },
        body: JSON.stringify(stats) });
      console.log(r.ok ? '\nEnviado pro Worker ✓' : '\nWorker respondeu '+r.status);
    } catch(e){ console.log('\nFalha ao enviar pro Worker:', e.message); }
  }
})().catch(e => { console.error('ERRO:', e.message); save(); process.exit(1); });
