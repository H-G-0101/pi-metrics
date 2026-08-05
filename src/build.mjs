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
 * Requer no Cloudflare: KV binding "STATS" e secret "STATS_TOKEN".
 */

const HORIZON = "https://api.mainnet.minepi.com";
const DASH = "${DASH}";
const INSP = "${INSP}";

function cors(r){
  r.headers.set("Access-Control-Allow-Origin","*");
  r.headers.set("Access-Control-Allow-Headers","authorization,content-type");
  r.headers.set("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  return r;
}
function html(b64){
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); // preserva UTF-8 (π, ■)
  return new Response(bytes, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    if (p.startsWith("/horizon/")) {
      const target = HORIZON + "/" + p.slice("/horizon/".length) + url.search;
      const r = await fetch(target, { headers: { Accept: "application/json" } });
      return cors(new Response(r.body, { status: r.status,
        headers: { "content-type": "application/json" } }));
    }

    if (p === "/stats") {
      if (req.method === "POST") {
        if (req.headers.get("authorization") !== "Bearer " + env.STATS_TOKEN)
          return cors(new Response("nao autorizado", { status: 401 }));
        await env.STATS.put("migracao", await req.text());
        return cors(new Response("ok"));
      }
      const v = await env.STATS.get("migracao");
      return cors(new Response(v || "null",
        { headers: { "content-type": "application/json" } }));
    }

    if (p === "/inspetor") return html(INSP);
    return html(DASH);
  }
};
`;

writeFileSync(join(here, '..', 'worker.js'), worker);
console.log('worker.js regenerado (' + worker.length + ' bytes)');
