# v27 — correções de classificação, persistência e apresentação

## Instalação

1. Substitua os arquivos do projeto pelos deste pacote, incluindo `src`, `worker.js`, `migracao-stats.mjs` e o workflow.
2. Publique o Worker usando o `wrangler.toml` incluído, que preserva os bindings STATS e DB. Mantenha o secret STATS_TOKEN existente.
3. Execute **Crawl Pi migrations** após o deploy. Não precisa apagar D1 nem checkpoint. O agendamento continua a cada seis horas; não há garantia de início imediato pelo GitHub.
4. Confira `/stats`: `schemaVersion: 15`, `classificationPolicy: confirmed-only-v27` e `lifetimeBasis: persistent-index`. A home avisa enquanto ainda exibe relatório antigo.

O Worker rejeita publicações dos crawlers antigos (schema abaixo de 15). Evite manter uma execução antiga durante a troca de versão. Os arquivos de cache/checkpoint devem ser preservados.

## O que mudou

- Sem histórico suficiente, a rodada permanece pendente. Idade da conta e ausência de create_account não identificam uma segunda migração.
- A verificação de criação exige destinatário, origem e hash correspondentes. Caches antigos dessa verificação são revalidados.
- Totais Lifetime usam somente o índice histórico persistente: não perdem carteiras quando eventos saem dos 15 dias. São totais indexados, ainda parciais enquanto o histórico avança.
- Cursor e índice não são mais separados ao restaurar. Um checkpoint antigo que já esteja à frente do D1 exige uma cópia congelada; essa recuperação inicial pode demorar.
- A cópia congelada retoma o offset do mesmo snapshot. Escritas recusadas e metadados finais não confirmados não avançam o offset nem marcam o D1 como pronto.
- Em novas páginas históricas, uma falha de sincronização reverte somente aquela página localmente. Na próxima execução, ela pode ser recuperada sem recopiar o índice inteiro.
- Orçamento local contabiliza rows_written devolvido pelo D1. O limite preventivo ainda é estimado e não conhece gastos de outros processos na conta.
- SKIP_HISTORY não é permitido: pular o passado impede estabelecer ordinais confiáveis.
- Textos auxiliares maiores, tabelas de distribuição adaptadas à largura, Data health abaixo do ranking, gráficos com escala e consulta por toque/teclado. “Account balance” esclarece que reservas podem estar incluídas.
- Metodologia e explicações removem a falsa garantia de que conta antiga significa segunda migração.

## Validação e limites

Execute `node src/build.mjs` e `node audit-tests.cjs`.

Os testes cobrem evidência insuficiente, idade da conta, agrupamento, expiração recente sem perda Lifetime, restauração, cursor, retomada de seed, cota, escritas medidas e rejeição de relatórios antigos.

Não houve deploy nem consulta autenticada ao D1 de produção. Não foi possível validar a renderização em navegador neste ambiente. Os dados históricos existentes não foram apagados nem certificados retroativamente: registros previamente corrompidos exigem comparação com as operações originais ou reconstrução controlada. Totais antigos inferidos podem cair na primeira publicação corrigida; isso não significa exclusão de carteiras do D1.
