# v31 — atualização frequente nos números do overview

Publique o Worker deste pacote, mantendo o Cron Trigger a cada minuto e os bindings existentes. Não apague D1 ou checkpoints. A próxima coleta publicará `version: 31` e `metrics24h` em `/live`.

A lista individual da coleta Live foi removida da home. O Migration overview recebe cartões numéricos de eventos, primeiras migrações confirmadas, pendências, migrações posteriores e Pi recebido em 24 horas. O cartão existente **New 2nd migrations · 24h** recebe a quantidade de carteiras com segunda migração confirmada pela coleta frequente.

Os números são calculados sobre todos os eventos armazenados na janela de 24 horas, não somente os últimos 20. Bloqueios da mesma carteira e hash formam um evento. A classificação usa evidência histórica validada; recebimento sem evidência permanece pendente. Os valores agregados são calculados uma vez por coleta, não a cada visita ao site.

Durante a recuperação ou quando existem operações acumuladas, a interface mostra `≥` e **Partial coverage · observed so far**. Os números não devem ser tratados como totais completos nessa situação. Um erro de coleta também deixa a cobertura parcial ou o horário anterior visível.

Lifetime, sete dias, médias e gráficos de 15 dias continuam dependendo do relatório histórico; esta versão não mistura automaticamente períodos diferentes. O Top 20 semanal original foi preservado.

Testes executados: histórico, coleta incremental e agregados exatos de 24 horas, com classificação pendente e confirmação posterior. Os agregados acrescentam leituras D1 proporcionais à quantidade de eventos na janela; o consumo depende do volume real.
