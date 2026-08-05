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

O crawler percorre os pagamentos da carteira e, no fim, empurra o resultado pro Worker.
O card "2ª migração" do painel se preenche sozinho.

Cada execução do GitHub roda até ~6h. Se a carteira for grande e não terminar, o
`checkpoint.json` fica no cache e a próxima execução **retoma de onde parou** — é só rodar
de novo (ou deixar o agendamento diário).

## 3. Achar o critério da 2ª migração

Antes do crawl longo, abra `/inspetor` no Worker e clique **Amostrar**. O veredito diz se a
2ª migração se separa por **valor**, **memo** ou se é pra usar o modo padrão (`count`).

No `migracao-stats.mjs`, o modo é controlado por `MODE`:
- `count` — quem recebeu ≥2 pagamentos já pegou a 2ª (padrão, não precisa de marca).
- `date`  — pagamentos a partir de `ROUND2_FROM` contam como rodada 2.

O `paymentsPerRecipient` no resultado valida o método: se quase todo mundo tem 1 ou 2
pagamentos, o `count` está certo.

## 4. Editar o visual

Mexa em `src/dashboard.html` ou `src/inspetor.html`, rode `node src/build.mjs` pra
regenerar o `worker.js`, e commite. O build embute os HTMLs no Worker em base64.

## Configuração do crawler

O `migracao-stats.mjs` lê variáveis de ambiente (o workflow já passa as certas), com
estes padrões: `HORIZON`, `WALLET`, `MODE`, `PUSH_URL`, `PUSH_TOKEN`. Dá pra rodar local
também: `PUSH_URL=... PUSH_TOKEN=... node migracao-stats.mjs`.
