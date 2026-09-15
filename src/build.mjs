/**
 * Build: regenera ../worker.js embutindo os HTMLs de src/ em base64.
 * Rode depois de editar dashboard.html ou inspetor.html:
 *     node src/build.mjs
 * Só precisa de Node 18+. Sem dependências.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const b64 = f => readFileSync(join(here, f), 'utf8')  // lê UTF-8
  && Buffer.from(readFileSync(join(here, f))).toString('base64'); // e codifica os bytes crus

const DASH = Buffer.from(readFileSync(join(here, 'dashboard.html'))).toString('base64');
const INSP = Buffer.from(readFileSync(join(here, 'inspetor.html'))).toString('base64');
const METHOD = Buffer.from(readFileSync(join(here, 'methodology.html'))).toString('base64');

const worker = `/**
 * Pi Mainnet — Worker único (sobe SÓ este arquivo no Cloudflare)
 * ---------------------------------------------------------------
 * GERADO por src/build.mjs — não edite à mão; edite src/*.html e rode o build.
 *
 *   GET  /            -> painel de rede (dashboard)
 *   GET  /inspetor    -> inspetor de carteira
 *   *    /horizon/... -> proxy pro Horizon do Pi (resolve CORS)
 *   GET  /stats       -> devolve a estatística de migração salva
 *   POST /stats       -> o crawler manda o resultado aqui (precisa do token)
 *
 * Requer no Cloudflare: KV "STATS", D1 "DB" e secret "STATS_TOKEN".
 */

const HORIZON = "https://api.mainnet.minepi.com";
const DASH = "${DASH}";
const INSP = "${INSP}";
const METHOD = "${METHOD}";

function cors(r){
  r.headers.set("Access-Control-Allow-Origin","*");
  r.headers.set("Access-Control-Allow-Headers","authorization,content-type");
  r.headers.set("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  return r;
}
function html(b64){
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); // preserva UTF-8 (π, ■)
  return new Response(bytes, { headers: {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
  } });
}

function json(data, status = 200){
  return cors(new Response(JSON.stringify(data), { status, headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  } }));
}

function authorized(req, env){
  return req.headers.get("authorization") === "Bearer " + env.STATS_TOKEN;
}

let schemaReady = false;
async function ensureD1(env){
  if (schemaReady) return;
  if (!env.DB) throw new Error("binding D1 DB ausente");
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS migration_wallets (address TEXT PRIMARY KEY, first_tx TEXT NOT NULL, first_at TEXT NOT NULL, second_tx TEXT, second_at TEXT, event_count INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, last_tx TEXT)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_wallets_second_at ON migration_wallets(second_at)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS recent_migrations (address TEXT NOT NULL, transaction_hash TEXT NOT NULL, created_at TEXT NOT NULL, amount_pi REAL NOT NULL DEFAULT 0, balance_count INTEGER NOT NULL DEFAULT 1, migration_number INTEGER, PRIMARY KEY(address, transaction_hash))"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS sync_state (name TEXT PRIMARY KEY, cursor TEXT, updated_at TEXT)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS migration_operations (operation_id TEXT PRIMARY KEY, address TEXT NOT NULL, transaction_hash TEXT NOT NULL, created_at TEXT NOT NULL, amount TEXT NOT NULL, predicate_json TEXT NOT NULL)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS migration_operations_event ON migration_operations(address,transaction_hash)"),
  ]);
  try {
    await env.DB.prepare("ALTER TABLE migration_wallets ADD COLUMN last_tx TEXT").run();
  } catch (error) {
    if (!String(error.message).toLowerCase().includes("duplicate column")) throw error;
  }
  schemaReady = true;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    if (p === "/wallet-balances") {
      const addresses = [...new Set((url.searchParams.get("addresses") || "").split(","))]
        .filter(address => /^G[A-Z2-7]{55}$/.test(address)).slice(0, 20);
      if (!addresses.length) return json({ balances: {} });
      const pairs = await Promise.all(addresses.map(async address => {
        try {
          const response = await fetch(HORIZON + "/accounts/" + address, { headers: { Accept: "application/json" } });
          if (!response.ok) return [address, null];
          const account = await response.json();
          const native = (account.balances || []).find(balance => balance.asset_type === "native");
          return [address, native ? Number(native.balance) : null];
        } catch (error) {
          return [address, null];
        }
      }));
      return json({ balances: Object.fromEntries(pairs), generatedAt: new Date().toISOString() });
    }

    if (p.startsWith("/horizon/")) {
      const target = HORIZON + "/" + p.slice("/horizon/".length) + url.search;
      const r = await fetch(target, { headers: { Accept: "application/json" } });
      return cors(new Response(r.body, { status: r.status,
        headers: { "content-type": "application/json" } }));
    }

    if (p === "/d1/evidence") {
      if (!authorized(req,env)) return json({error:'Unauthorized'},401);
      try {
        await ensureD1(env);
        const row=await env.DB.prepare("SELECT cursor FROM sync_state WHERE name=?1").bind('evidence:'+url.searchParams.get('address')).first();
        return json({evidence:row?JSON.parse(row.cursor):null});
      }catch(error){return json({error:error.message},500);}
    }
    if (p === "/d1/sync") {
      if (req.method !== "POST") return json({ error: "metodo nao permitido" }, 405);
      if (!authorized(req, env)) return json({ error: "nao autorizado" }, 401);
      try {
        await ensureD1(env);
        const body = await req.json();
        const wallets = Array.isArray(body.wallets) ? body.wallets : [];
        const operations = Array.isArray(body.operations) ? body.operations : [];
        if (operations.length>200) return json({error:'too many operations'},400);
        if(wallets.length>200)return json({error:"page too large"},400);
        const now = new Date().toISOString();
        const statements = wallets.map(row => env.DB.prepare(
          "INSERT INTO migration_wallets (address,first_tx,first_at,second_tx,second_at,event_count,updated_at,last_tx) VALUES (?1,?2,?3,?4,?5,?6,?7,?8) " +
          "ON CONFLICT(address) DO UPDATE SET first_tx=excluded.first_tx,first_at=excluded.first_at,second_tx=excluded.second_tx,second_at=excluded.second_at,event_count=excluded.event_count,updated_at=excluded.updated_at,last_tx=excluded.last_tx"
        ).bind(row.address, row.firstTx, row.firstAt, row.secondTx || null, row.secondAt || null,
          Number(row.eventCount || 1), now, row.lastTx || row.secondTx || row.firstTx));
        for (const op of operations) {
          if (!op.id || !op.address || !op.hash || !op.at || !/^[0-9]+([.][0-9]{1,7})?$/.test(op.amount)) return json({error:'invalid operation'},400);
          statements.push(env.DB.prepare("INSERT INTO migration_operations(operation_id,address,transaction_hash,created_at,amount,predicate_json) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(operation_id) DO NOTHING").bind(op.id,op.address,op.hash,op.at,op.amount,JSON.stringify(op.predicate||{})));
        }
        if(body.verification){
          statements.push(env.DB.prepare("INSERT INTO sync_state(name,cursor,updated_at) VALUES (?1,?2,?3) ON CONFLICT(name) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at").bind('evidence:'+body.verification.address,JSON.stringify(body.verification.evidence),now));
        }
        if (body.meta) {
          statements.push(env.DB.prepare(
            "INSERT INTO sync_state (name,cursor,updated_at) VALUES ('crawler',?1,?2) ON CONFLICT(name) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at"
          ).bind(JSON.stringify(body.meta), now));
        }
        const results = statements.length ? await env.DB.batch(statements) : [];
        const rowsWritten = results.reduce((sum, result) => sum + Number(result.meta?.rows_written || 0), 0);
        return json({ ok: true, saved: wallets.length, rowsWritten, ledgerProtocol:28 });
      } catch (error) {
        return json({ error: error.message }, 500);
      }
    }

    if (p === "/d1/restore") {
      if (req.method !== "GET") return json({ error: "metodo nao permitido" }, 405);
      if (!authorized(req, env)) return json({ error: "nao autorizado" }, 401);
      try {
        await ensureD1(env);
        if(url.searchParams.get("metaOnly")){
          const row=await env.DB.prepare("SELECT cursor FROM sync_state WHERE name='crawler'").first();
          return json({protocol:26,meta:row?JSON.parse(row.cursor):null});
        }
        const after = url.searchParams.get("after") || "";
        const [walletResult, metaResult] = await env.DB.batch([
          env.DB.prepare("SELECT address,first_tx,first_at,second_tx,second_at,event_count,last_tx FROM migration_wallets WHERE address > ?1 ORDER BY address LIMIT 501").bind(after),
          env.DB.prepare("SELECT cursor FROM sync_state WHERE name='crawler' LIMIT 1"),
        ]);
        const sourceRows = walletResult.results || [];
        const hasMore = sourceRows.length > 500;
        const rows = sourceRows.slice(0, 500).map(row => ({
          address: row.address,
          firstTx: row.first_tx,
          firstAt: row.first_at,
          secondTx: row.second_tx,
          secondAt: row.second_at,
          eventCount: row.event_count,
          lastTx: row.last_tx,
        }));
        let meta = null;
        try { meta = JSON.parse(metaResult.results?.[0]?.cursor || "null"); } catch (error) {}
        return json({ wallets: rows, hasMore, meta });
      } catch (error) {
        return json({ error: error.message }, 500);
      }
    }

    if (p === "/stats") {
      if (req.method === "POST") {
        if (!authorized(req, env))
          return cors(new Response("nao autorizado", { status: 401 }));
        let incoming;
        try { incoming = JSON.parse(await req.text()); }
        catch (error) { return json({ error: "JSON invalido" }, 400); }
        let previous = null;
        try { previous = JSON.parse(await env.STATS.get("migracao") || "null"); }
        catch (error) {}
        if(!incoming || incoming.schemaVersion<15)return json({error:'Crawler update required: schema 15 (v27)'},409);
        if(!Number.isFinite(Date.parse(incoming.generatedAt)))return json({error:'Invalid report timestamp'},400);
        if(previous?.schemaVersion>=14 && Date.parse(incoming.generatedAt)<Date.parse(previous.generatedAt))return json({error:'Older report rejected'},409);
        incoming.lifetimeTotalsProtected=false;
        incoming.receivedAt = new Date().toISOString();
        await env.STATS.put("migracao", JSON.stringify(incoming));
        return cors(new Response("ok"));
      }
      const v = await env.STATS.get("migracao");
      return cors(new Response(v || "null",
        { headers: {
          "content-type": "application/json",
          "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
          "cdn-cache-control": "no-store",
        } }));
    }

    if (p === "/inspetor") return html(INSP);
    if (p === "/methodology") return html(METHOD);
    return html(DASH);
  }
};
`;

writeFileSync(join(here, '..', 'worker.js'), worker);
console.log('worker.js regenerado (' + worker.length + ' bytes)');
