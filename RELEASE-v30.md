# v30 — recebimentos com coleta independente

## Ativar

1. Substitua os arquivos pelo pacote completo e publique o Worker usando o `wrangler.toml` incluído. O `worker.js` já está gerado.
2. Preserve os bindings DB e STATS e o secret STATS_TOKEN. Não apague tabelas ou checkpoints.
3. Confirme que o Worker recebeu um Cron Trigger `* * * * *`. O arquivo configura esse agendamento. Se você publica colando somente worker.js no editor, precisa adicionar o Cron Trigger no painel Cloudflare; colar JavaScript não aplica wrangler.toml.
4. Na home, confira **Live migration receipts**. `/live` mostra `version: 30`, `checkedAt`, possíveis erros e os últimos recebimentos.
5. Atualize também o workflow e o crawler incluídos. O Action histórico continua a cada seis horas, com orçamento reduzido para reservar capacidade ao coletor frequente. Ele não precisa terminar para o quadro Live funcionar.

Cron Triggers: https://developers.cloudflare.com/workers/configuration/cron-triggers/
Alterações de agendamento podem levar tempo para propagar. Esta entrega não executou um deploy na sua conta.

## O que atualiza frequentemente

Um coletor no Cloudflare consulta novas operações a cada minuto, usando cursor independente. A página consulta seu resultado a cada 20 segundos enquanto estiver visível. O quadro mostra os 20 eventos detectados mais recentes, com carteira, Pi recebido, número de bloqueios, transação e classificação disponível.

Os totais Lifetime, médias, gráficos e Top 20 semanal existentes continuam baseados no relatório histórico. Não somamos automaticamente recebimentos recentes a esses totais, o que duplicaria eventos e poderia afirmar rodadas ainda desconhecidas.

Quando o D1 já contém a verificação da carteira pela política 29 e o hash está nela, a rodada aparece confirmada. Caso contrário, aparece **Received · classification pending**. Encontrar um recebimento não exige esperar a análise histórica. Contas antigas não são automaticamente consideradas segunda migração.

## Retomada e recuperação

A primeira execução lê a página mais recente e inicia recuperação gradual de até 24 horas antes da ativação. As próximas execuções priorizam até duas páginas novas e uma página de recuperação, com 200 operações por página. A capacidade não é ilimitada: durante volumes maiores pode surgir uma fila. O painel sinaliza **Catching up** e valores ainda parciais.

Cada operação tem ID único. Uma inserção repetida não incrementa os valores. Operações e cursor são gravados na mesma transação; um gatilho agrega os bloqueios por carteira + hash usando unidades inteiras. Um bloqueio pode chegar em outra página e completar o valor depois.

As tabelas novas são `live_control`, `live_receipt_ops` e `live_receipts`. Nenhuma delas substitui o índice histórico. Um bloqueio temporário com identificação da execução evita que dois coletores processem o mesmo cursor simultaneamente. Falhas e cotas não pulam operações.

## Limites e custos

Orçamentos preventivos deste pacote: 30.000 escritas/dia UTC para recibos e 50.000 para o histórico. São limites locais de precaução, não medidores completos da conta Cloudflare. As escritas efetivas reportadas pelo D1 são contabilizadas; índices, metadados, gatilhos e outros aplicativos também consomem recursos.

Se houver pausa por orçamento ou erro do provedor, o painel mostra o problema e o horário da última coleta bem-sucedida. Quando a coleta retomar, continua pelo cursor. Não há garantia de tempo real ou de cobertura contínua sem recursos suficientes.

O resultado Live é salvo no D1 e lido pelo Worker; não realiza uma escrita KV a cada minuto. As tabelas existentes de histórico são preservadas.

## Testes

- `node src/build.mjs`
- `node audit-tests.cjs`
- `node real-sample-tests.cjs`
- `node live-tests.mjs` (usa SQLite integrado, execute com Node 24)

Os testes Live verificam SQL real em SQLite: páginas divididas, somas, repetição, rollback, retomada, concorrência, cota, destinatário ambíguo e confirmação somente com evidência. Os testes históricos existentes continuam passando. Não houve medição de latência, teste de carga ou validação visual em produção.
