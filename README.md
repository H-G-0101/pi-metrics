# Pi Mainnet — painel + estatística de migração

**Atualização v28:** leia [RELEASE-v28.md](RELEASE-v28.md) antes de publicar.
As regras atuais excluem inferências de rodada, usam somente o índice persistente
nos totais Lifetime e corrigem a retomada do D1. Essas regras substituem quaisquer
descrições de versões anteriores abaixo. Publique Worker e crawler juntos.

Um painel ao vivo da rede Pi mainnet e uma estatística de quem já recebeu a 2ª migração.
Tudo roda hospedado: o app num **Cloudflare Worker**, o crawl no **GitHub Actions**. Sem PC.

No Top 20 semanal, o botão ao lado de cada endereço copia a carteira completa e
confirma visualmente a ação.

O ranking também exibe o saldo disponível atual e detalha cada parcela criada
pela migração, incluindo valor e duração do bloqueio. O prazo é calculado a
partir do predicado do destinatário no `create_claimable_balance`.

Para manter o checkpoint abaixo do limite de serialização do Node.js, a janela
recente é publicada no relatório, mas não é duplicada no `checkpoint.json`.
Ela é reconstruída pelo Horizon no começo de cada execução.

Na janela recente, uma transação com `create_account` e
`create_claimable_balance` para o mesmo destinatário é classificada imediatamente
como primeira migração, mesmo antes de o cursor histórico alcançar essa conta.
Essa confirmação exige correspondência da carteira criada com o destinatário;
compartilhar apenas o mesmo hash de um lote não é suficiente.

O índice histórico é salvo em partes dentro de `checkpoint.json.parts`, enquanto
`checkpoint.json` guarda somente os metadados. O workflow deve armazenar os dois
caminhos para permitir a retomada de índices com milhões de carteiras.

No ranking, a linha principal e o respectivo lockup schedule formam um único
grupo visual. Os grupos alternam entre tonalidades clara e escura para facilitar
a identificação de onde termina uma carteira e começa a próxima.

A visão geral inclui médias separadas de primeira e segunda migração nos últimos
15 dias. Cada evento entra uma vez na média, depois da soma de todos os lockups
com o mesmo destinatário e hash; eventos pendentes não entram no cálculo. Enquanto
o Worker ainda estiver servindo um relatório anterior ao schema 11, os cards
informam que estão aguardando a execução do crawler atualizado.

A mesma janela também exibe o volume total e a mediana separados por primeira e
segunda migração. A cobertura de classificação informa quantos eventos recentes
já foram associados com segurança a uma dessas duas rodadas.

Os insights adicionais usam os mesmos eventos agrupados por destinatário e hash:
distribuição dos lockups por duração, volume diário de Pi, participação da segunda
migração, faixas de tamanho e maiores eventos classificados das últimas 24 horas.

Na v26, os totais podem diminuir quando uma classificação incorreta é corrigida.
Não se mantém artificialmente o maior valor antigo. O D1 armazena carteiras,
hashes e cursor; falhas interrompem a execução e são informadas no painel.
Leia RELEASE-v26.md para a ordem de publicação e limitações de recuperação.

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

O binding D1 `DB` do banco `pi-migrations` também está declarado no
`wrangler.toml`. Isso impede que uma nova publicação remova o vínculo criado
no painel da Cloudflare.

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

Ao iniciar, o crawler lê primeiro os últimos 15 dias em ordem decrescente e publica
essa janela no Worker. Assim, ranking, valores semanais e gráfico de 14 dias aparecem
sem esperar o índice histórico terminar. Depois ele retoma a leitura completa das
operações antigas em ordem crescente. O painel mostra:

A primeira página recente é publicada imediatamente. Durante a continuação da leitura,
o painel mostra `dados parciais` e atualiza o ranking em novos lotes, sem ficar vazio.
A home verifica o `/stats` a cada 10 segundos e usa cache desativado.

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

O crawler publica progresso parcial a cada 250 páginas e novamente ao encerrar a
execução. Enquanto o histórico completo não tiver sido percorrido, o painel mostra
“índice em construção”. Eventos recentes cuja posição ainda depende do histórico
aparecem como `em análise` e são classificados automaticamente conforme o índice
avança. `PUSH_EVERY_PAGES` permite alterar a frequência de publicação.

## Índice persistente no Cloudflare D1

Além do KV `STATS`, vincule ao Worker um banco D1 com o nome de variável `DB`.
O Worker cria/verifica as tabelas automaticamente; o mesmo esquema também está em
`schema.sql` para execução manual no Console do D1.

Na primeira execução desta versão, o crawler copia até 15.000 carteiras já conhecidas
para o D1. Se houver mais, continua na execução seguinte sem pausar o avanço histórico.
Esse limite mantém margem dentro das 100.000 gravações diárias do plano gratuito.
Quando a cópia termina, a home mostra `D1 persistente`.

Depois disso, cada página histórica atualiza o D1 junto com o checkpoint. Se o cache
do GitHub Actions desaparecer, o crawler restaura do D1 as carteiras, os hashes e o
cursor, evitando recomeçar a leitura da blockchain do zero.
