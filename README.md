# Pi Mainnet — painel + estatística de migração

Um painel ao vivo da rede Pi mainnet e uma estatística de quem já recebeu a 2ª migração.
Tudo roda hospedado: o app num **Cloudflare Worker**, o crawl no **GitHub Actions**. Sem PC.

## Estrutura

```
pi-metrics/
├── worker.js               # O APP — sobe isto no Cloudflare (painel + inspetor + proxy + stats)
├── wrangler.toml           # config de deploy do Worker
├── migracao-stats.mjs      # crawler da carteira de migração (roda no GitHub Actions)
├── README.md
├── .github/
│   └── workflows/
│       └── crawl.yml        # agenda/dispara o crawl no GitHub
└── src/                     # fontes editáveis do worker (opcional)
    ├── dashboard.html       # o painel
    ├── inspetor.html        # o inspetor de carteira
    └── build.mjs            # regenera o worker.js a partir das fontes
```

O `worker.js` já vem pronto — o `src/` só importa se você quiser mexer no visual.

## Rotas do Worker

| Rota          | O que faz                                            |
|---------------|------------------------------------------------------|
| `/`           | painel de rede (altura do ledger, TPS, migração…)    |
| `/inspetor`   | inspeciona uma carteira e tabula valores/memos       |
| `/horizon/*`  | proxy pro Horizon do Pi (resolve o CORS)             |
| `/stats`      | GET devolve a estatística; POST recebe do crawler    |

## 1. Deploy do Worker (Cloudflare)

O projeto está conectado ao GitHub, então a config vem do `wrangler.toml`.

1. **Crie o KV**: Cloudflare → *Storage & Databases → KV → Create*. Nome `STATS`.
2. **Pegue o id** do namespace (a string hexadecimal de ~32 caracteres) e cole no
   `wrangler.toml`, na linha `id = "..."`, no lugar de `COLE_O_ID_DO_KV_AQUI`.
3. **Crie o secret**: Worker → *Settings → Variables and Secrets → Add → Secret*.
   Nome `STATS_TOKEN`, valor uma senha à sua escolha (guarde — é a mesma do crawler).
4. Commit na `main`. O build publica sozinho.

Abra a URL do Worker: o painel deve carregar e a altura do ledger subir a cada poucos segundos.

## 2. Rodar o crawl (GitHub Actions)

1. No `.github/workflows/crawl.yml`, troque `PUSH_URL` pela URL do seu Worker + `/stats`.
2. No repo: *Settings → Secrets and variables → Actions → New repository secret*.
   Nome `STATS_TOKEN`, **o mesmo valor** do secret do Worker.
3. Aba *Actions* → "Crawl migração Pi" → **Run workflow**.

O crawler percorre as operações da carteira e, quando alcança o topo da blockchain,
envia o resultado ao Worker. O painel mostra:

- pessoas únicas com 2ª migração detectada;
- novas 2ªs migrações nas últimas 24 horas e nos últimos 7 dias;
- histórico diário dos últimos 14 dias;
- 1ªs migrações detectadas pela mesma carteira.
- ranking semanal das 20 carteiras que mais receberam Pi, somando 1ª e 2ª migração.

Cada execução do GitHub roda até ~6h. Se a carteira for grande e não terminar, o
`checkpoint.json` fica no cache e a próxima execução **retoma de onde parou** — é só rodar
de novo (ou deixar o agendamento automático, configurado para quatro vezes por dia).

## 3. Como a 2ª migração é identificada

A fonte correta são as operações `create_claimable_balance` criadas pela carteira
de migração. A chave de deduplicação é:

```text
carteira destinatária + transaction_hash = um evento de migração
```

Uma migração pode criar um ou dois claimable balances no mesmo hash. Eles são parcelas
da mesma migração (por exemplo, uma parcela com bloqueio curto e outra com bloqueio
mais longo), portanto são somados, mas contam como somente um evento.

- primeiro hash distinto para o destinatário: **1ª migração**;
- segundo hash distinto para o mesmo destinatário: **2ª migração**;
- `claim_claimable_balance`: resgate de uma parcela, não uma nova migração;
- `create_account`: evidência adicional da primeira migração, não é usado sozinho
  para calcular a segunda.

O ranking semanal agrega o valor de todos os claimable balances criados para cada
carteira nos últimos sete dias. Se uma carteira receber primeira e segunda migração
na mesma janela, os valores aparecem somados e o tipo será `1ª e 2ª`.

## 4. Editar o visual

Mexa em `src/dashboard.html` ou `src/inspetor.html`, rode `node src/build.mjs` pra
regenerar o `worker.js`, e commite. O build embute os HTMLs no Worker em base64.

## Configuração do crawler

O `migracao-stats.mjs` lê variáveis de ambiente (o workflow já passa as principais):
`HORIZON`, `WALLET`, `RECOVERY_WALLET`, `PUSH_URL`, `PUSH_TOKEN`,
`THROTTLE_MS`, `PAGE_LIMIT` e `MAX_PAGES`.

Para testar só uma página sem enviar dados ao Worker:

```bash
MAX_PAGES=1 CHECKPOINT_FILE=/tmp/pi-checkpoint.json \
OUTPUT_FILE=/tmp/pi-stats.json node migracao-stats.mjs
```

O resultado parcial nunca é enviado ao Worker. O envio acontece somente quando o
crawler alcança o topo do histórico disponível no Horizon.
