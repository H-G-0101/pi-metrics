# Pi Migration Monitor — v47

## Novidade da v47 — controle, evidências e auditoria

Publique o pacote completo. Banco, dados, cursores, contadores e Cron único a cada minuto são preservados. Uma pequena tabela `collector_api_control` é criada automaticamente no mesmo D1 para compartilhar o ritmo e a pausa da API entre os coletores. Não precisa executar SQL manual ou reiniciar a recuperação.

### Consumo medido

Consultas instrumentadas leem `meta.rows_written` retornado pelo D1, inclusive operações com RETURNING. O orçamento é atualizado com esses valores após os lotes concluídos. Antes de enviar um lote ainda é necessária uma reserva conservadora. Gravações sem metadados, a última persistência do snapshot e liberação de trava aparecem como estimativas, separadas do consumo informado pelo banco. Uso anterior da v46 é carregado, sem zerar o orçamento. Uma interrupção após o commit pode deixar a reserva do lote no lugar da medição até nova execução; não é prometida reconciliação exata da fatura. O painel cobre estes coletores, não toda a conta Cloudflare, e não é um teto garantido de faturamento. Limites continuam iguais aos da v46.

Referência do formato D1: https://developers.cloudflare.com/d1/worker-api/return-object/

### Ritmo e evidências

O coletor reduz a concorrência pela metade diante de falhas, até uma consulta simultânea. A pausa compartilhada é de ao menos cinco minutos, respeitando Retry-After nas páginas de operações até uma hora. Após 30 páginas bem-sucedidas aumenta gradualmente um nível, até quatro. A quantidade de páginas por rodada acompanha esse nível. Cursors são preservados; erro não confirma migração. A leitura do saldo de origem mantém seu cache e falhas dessa leitura não interrompem a coleta das migrações.

Histórico e monitor atual consultam evidências um do outro. Só reutilizam prefixos confirmados, compatíveis e sem recuar cursor; não somam contadores entre períodos e não misturam evidências conflitantes. Consulta à API é dispensada quando o histórico salvo já confirma o evento pendente.

### Auditoria e pendências

A auditoria percorre no máximo 250 endereços com eventos por execução, enquanto houver tempo. Compara contagens de carteiras únicas, pendências e volumes exatos em unidades inteiras, além da consistência dos registros de fila associados. Ajusta o trecho já percorrido quando o próprio coletor modifica seus eventos. Ao concluir, aguarda 24 horas para iniciar novo ciclo. Detecta discrepâncias e mostra aviso; não repara nem altera totais automaticamente. Não prova cobertura da blockchain nem validade de todas as classificações e não substitui backup. Alterações externas durante a varredura podem produzir divergência que deve ser investigada.

Seções expansíveis mostram consumo, velocidade, resultado da auditoria e uma amostra de até 20 carteiras pendentes em ordem de tentativa. A amostra é atualizada aproximadamente a cada cinco minutos; não é uma distribuição da fila inteira. Motivos: aguardando primeira consulta, histórico em andamento, erro de API, criação da conta ausente e histórico ambíguo. Carteiras antigas podem não ter data inicial de pendência registrada; a versão não inventa essa data. Motivos também aparecem nos itens pendentes do Top 20 após a atualização do ranking.

Testes: `node focus-tests.mjs`, `node historical-tests.mjs`, `node transparency-tests.mjs`, `node reliability-tests.mjs`. Incluem metadados de gravação, fallback, rollback, pausa compartilhada, retomada gradual, auditoria com alterações durante a coleta, divergências e reaproveitamento inverso de evidências. Casos de bloqueio único, múltiplos bloqueios e transações com destinatários diferentes usam fixtures; não constituem auditoria ao vivo de transações reais. Não houve publicação nem inspeção visual em navegador real neste ambiente.

## Novidade da v46 — recuperação histórica acelerada

Um único Cron `* * * * *` executa primeiro o monitor atual e, em seguida, o histórico. O antigo `*/5 * * * *` é ignorado pela nova versão para evitar trabalho duplicado. O wrangler.toml já contém apenas o agendamento atual. Se publicar pelo editor da Cloudflare, mantenha o Cron a cada minuto e remova o antigo a cada cinco minutos. Não altere DB nem STATS e não apague tabelas.

O histórico mantém o cursor já salvo desde fevereiro de 2026. Busca até 24 páginas da origem por execução (antes 6), com até 20 segundos dedicados à varredura, reservando o restante do ciclo de 45 segundos à classificação. Consulta até 80 históricos por rodada (antes 40), em grupos de até quatro (antes dois). Tempos, filas, orçamentos e disponibilidade da API podem reduzir esses máximos. Não há promessa de multiplicador de velocidade ou prazo de conclusão.

Evidências do monitor atual são reutilizadas por destinatário quando têm origem do histórico comprovada, mesma política, sequência compatível e cursor que não retrocede. Ambiguidades e conflitos não são sobrescritos. Se a evidência já classifica o evento pendente, não há nova consulta à API para ele; se faltar informação, continua a partir do cursor reutilizado. Dados de eventos e contadores permanecem separados. A leitura das evidências existentes acrescenta consultas limitadas às carteiras do lote no D1.

Orçamento histórico aumentado para 500 mil gravações estimadas/dia, com até 300 mil dessa parcela dedicadas à classificação. O orçamento atual continua em 1 milhão. São estimativas internas, não garantia de consumo faturado; maior velocidade pode elevar uso e custo. Quem publica só worker.js precisa atualizar as variáveis antigas no painel para receber os novos orçamentos. Páginas configuráveis: HISTORICAL_SOURCE_PAGES=24 e HISTORICAL_HISTORY_PAGES=80.

Testes locais verificam reaproveitamento sem chamada à API, recusa de evidências incompatíveis, isolamento do monitor, avanço de 24 páginas, retomada exata, duplicação e orçamento. Publicação e velocidade real precisam ser conferidas após instalar a versão.

## Novidade da v45 — evidências e progresso

- Ritmo da fila ao longo da última hora: recebimentos adicionados e pendências classificadas, medidos separadamente em cada coletor.
- Estimativa usa pendentes / redução líquida por hora; exige 60 minutos de observação. Não aparece com fila crescendo, coleta em recuperação, erros, pausa da API ou orçamento esgotado. É uma projeção, não prazo garantido.
- Top 20 possui detalhes na classificação com links das primeiras duas migrações, quando as evidências salvas sustentam essas posições. A transação pode conter outros destinatários: conferir o beneficiário. Evidências fora do Top 20 não são consultadas pela interface.
- Idades de atualização separadas para contadores, fila, Top 20, histórico e saldo de origem.
- Barra histórica mostra fração do intervalo de datas percorrido, não percentual de eventos classificados ou estimativa de duração.

Publique o pacote completo. Não altere o banco, os bindings nem os Crons. Dados e início do acompanhamento são preservados. Telemetria começa após a publicação e usa o estado existente, sem tabelas novas e sem reprocessar eventos antigos. O Top 20 atualiza suas evidências no próximo ciclo de atualização (aproximadamente cinco minutos). A interface não consulta a API da Pi ao abrir evidências; são links para o explorador. O coletor faz uma leitura adicional limitada às 20 carteiras quando reconstrói o ranking.

Validação: testes locais do coletor e histórico, testes de estimativa e evidências, execução do JavaScript da interface com respostas simuladas e verificação de sintaxe. Não foi feita validação visual em navegador real nem publicação em produção neste ambiente.

## Novidade da v44 — clareza e apresentação

Home reorganizada com Overview, History e Top 20; cartões indicam período, carteiras únicas e total de Pi migrado incluindo bloqueios. Histórico possui aviso visível de sobreposição. Recebimentos pendentes são rotulados como recebidos aguardando classificação; progresso de coleta e classificação são descritos separadamente. Datas padronizadas em UTC, cores sóbrias e layout responsivo. Mantidos banco, dados, coleta e agendamentos.

## Correção da v43 — período histórico desde 01/02/2026 UTC

A data correta substitui o recorte de fevereiro de 2025 usado nas versões anteriores. O coletor e a rota /historical agora usam tabelas historical2026_*, criadas automaticamente no mesmo D1. A recuperação corrigida começa no novo limite; tabelas historical_* antigas são preservadas, mas não alimentam o cartão nem continuam sendo processadas. Contadores principais, Pi acumulado e Top 20 em focus_* são preservados. Não apague o banco nem reinicie os contadores principais.

Publique worker.js e os arquivos atualizados. Os dois agendamentos continuam iguais. A seção histórica volta temporariamente a Preparing/Partial enquanto recupera o período correto. Os dados antigos continuam ocupando armazenamento; nenhuma exclusão automática é feita. Mantidas as datas reais de início dentro dos dois cartões principais, introduzidas na v42.

As notas abaixo descrevem a evolução das versões anteriores; o recorte vigente é fevereiro de 2026.

## Novidade da v42

Os dois cartões principais agora mostram a data real do início do acompanhamento, logo abaixo do título, em UTC. O horário completo aparece no tooltip. O período histórico permanece indicado separadamente desde 01/02/2025 UTC. Alteração de apresentação; nenhuma data, tabela, contador ou rotina de coleta foi reiniciada.

## Novidade da v41 — Historical 2nd migrations

Nova seção azul na home, separada dos contadores desde a ativação. Mostra carteiras com segunda migração confirmada e Pi acumulado a partir de **01/02/2025 00:00 UTC**, com data alcançada pela varredura, data-alvo e pendências. A data define o recorte de busca; não afirma que segundas migrações começaram nessa data. O escopo é exclusivamente a carteira de migração exibida no site.

### Publicação

Publique o projeto completo, incluindo **worker.js e wrangler.toml**. Mantenha o banco e os dados atuais. O novo Cron `*/5 * * * *` executa a recuperação a cada cinco minutos; o Cron `* * * * *` continua dedicado ao monitor atual. Se publicar pelo editor do Cloudflare, adicione também o novo Cron no painel. Não precisa de GitHub Actions ou comandos SQL manuais. Confira v41 no rodapé e a resposta de `/historical`.

As tabelas `historical_control`, `historical_events` e `historical_wallets` são criadas automaticamente no mesmo D1, com cursor e trava separados das tabelas `focus_*`. Nenhum total histórico é somado ao contador atual; há sobreposição entre os períodos. Não some os dois cartões.

### Como a recuperação funciona

Primeiro localiza o primeiro ledger do período por busca binária, em etapas salvas. Isso pode levar várias execuções de cinco minutos. Usa o token real da primeira operação do ledger e trata ledgers sem operações. Se a API não disponibilizar os ledgers necessários, mostra erro e não presume cobertura.

Depois lê até seis páginas de operações da carteira de origem por execução, até a data-alvo registrada, e confirma até 40 páginas de históricos de destinatários, com duas requisições simultâneas. Verifica histórico anterior a fevereiro quando necessário para estabelecer a ordem. Cada evento é agrupado por destinatário e transação; um ou vários bloqueios não mudam essa regra. First migrations presentes no mesmo lote não são contadas como second migrations. Progresso e valores são gravados atomicamente, sem duplicação em retomadas. Quando alcança a data-alvo, passa a buscar os novos recebimentos nas próximas execuções.

O rótulo **Partial** permanece enquanto a varredura ou classificação estiver incompleta. **Caught up** significa que alcançou a data-alvo exibida e classificou os recebimentos encontrados, não uma garantia de cobertura de outras carteiras de origem ou registros ausentes na API. Ausência da criação da conta no histórico mantém a classificação pendente.

### Consumo e controles

- HISTORICAL_ENABLED = "true"; mudar para "false" pausa só a recuperação e preserva seus dados.
- HISTORICAL_DAILY_WRITE_BUDGET = "250000": teto diário estimado deste coletor.
- HISTORICAL_VERIFICATION_WRITE_BUDGET = "150000": parte do teto anterior reservada à verificação.

São orçamentos adicionais aos do coletor atual. O banco, franquia, armazenamento e capacidade da API são compartilhados: a recuperação acrescenta consumo, apesar de não bloquear o agendamento da coleta atual. Os limites internos são estimativas, não garantia de custo/faturamento. Monitore as métricas reais e pause a recuperação se necessário. Não há prazo de conclusão garantido. O agendamento, implantação e disponibilidade do histórico real precisam ser verificados após publicar; os testes locais usam fixtures.

## Novidade da v40

Volumes acumulados de Pi para primeira e segunda migrações, abaixo de cada contador, abreviados K/M e com valor completo no tooltip. Somam os bloqueios dos eventos confirmados desde o início do monitor; pendentes entram após confirmação. Não são saldos atuais e não diminuem com saques ou desbloqueios. Na atualização, uma leitura inicial das tabelas focus recupera os valores já registrados; depois os totais são atualizados incrementalmente, na mesma transação dos contadores. Sem novas consultas à blockchain, novas tabelas ou reset do período.

## Novidade da v39 — perfil Workers Paid

Até 80 páginas de histórico por execução, em lotes de quatro consultas paralelas. Prazo de 45 segundos para iniciar novos lotes; cada chamada tem timeout de 10 segundos. Gravação atômica por lote, reaproveitamento do cursor e pausa histórica de cinco minutos em HTTP 429/5xx. A coleta de recebimentos continua independente dessa pausa. Top 20 é priorizado e a fila geral continua avançando.

Configuração no wrangler.toml (publique o arquivo junto com worker.js):
- FOCUS_HISTORY_PAGES = 80 (máximo 80)
- FOCUS_HISTORY_CONCURRENCY = 4 (máximo 4)
- FOCUS_DAILY_WRITE_BUDGET = 1000000
- FOCUS_HISTORY_WRITE_BUDGET = 400000 (incluído no orçamento total)

Se publicar somente worker.js pelo painel, atualize também essas quatro variáveis em Settings: valores antigos de 85000/5000 prevalecem sobre os padrões novos. Não precisa alterar ou apagar DB, iniciar novo período ou executar GitHub Actions. Verifique v39 no rodapé.

Os orçamentos são estimativas internas diárias, não medição de faturamento nem garantia de ficar dentro da franquia mensal. Outros serviços, índices e operações auxiliares também consomem D1. Acompanhe as métricas reais no Cloudflare. O ritmo depende da API, tamanho dos históricos e cota; 80 é um teto, não garantia por minuto.

## Histórico: novidade da v38

A verificação usa o Top 20 já publicado (cache de até 5 minutos), sem recalcular o ranking a cada execução. Até três consultas históricas priorizam suas carteiras pendentes e uma atende a fila geral. Vagas livres são reaproveitadas, sempre com no máximo quatro páginas por execução e respeitando o orçamento histórico existente. Carteiras em espera por erro mantêm seu prazo de tentativa. A prioridade não garante confirmação imediata quando há limite de cota ou histórico incompleto.

Não exige alterar o banco nem reiniciar o período. Preserve DB, o Cron e os dados existentes. Mantenha o workflow antigo desabilitado.

## Novidade da v37

A home exibe o endereço completo da carteira de migração, link para o explorador e botão de copiar. Mostra o saldo nativo dessa carteira com cache de cinco minutos, sem consultar saldos de destinatários. O saldo é o informado pela conta e não uma estimativa de valor livre após reservas. Uma falha nessa consulta preserva o último saldo conhecido, informa o atraso e não impede a gravação das migrações.

A última migração observada é persistida junto ao cursor e usa apenas recebimentos create_claimable_balance válidos da origem. Pagamentos e outras operações não alteram esse horário. A idade aparece em minutos, depois horas e dias, com data absoluta ao passar o mouse. Antes do primeiro recebimento observado, aparece "Not observed yet". O valor se refere ao período acompanhado, e pode estar atrasado se houver fila ou falha de coleta.

A atualização da v36 para a v37 não inicia outro período nem zera contadores. O horário da última migração já armazenada é recuperado uma única vez das tabelas focus existentes. O Worker retorna version 37 em /live. As instruções abaixo sobre ativação da v36 continuam valendo para a primeira ativação do monitor enxuto.

Versão enxuta: carteiras com primeira migração confirmada, carteiras com segunda migração confirmada e Top 20 por Pi recebido nos últimos sete dias. Interface em inglês, números K/M, cópia de endereço, horário da última coleta e pendências de classificação.

## Instalar

1. Atualize o repositório com o pacote completo, incluindo `.github/workflows/crawl.yml`, `wrangler.toml`, `worker.js` e `src/`.
2. Publique o Worker com o wrangler.toml. O binding `DB` continua apontando para `pi-migrations`; o Cron continua `* * * * *`.
3. Se uma Action antiga ainda estiver rodando, cancele essa execução uma vez. O novo workflow não tem agendamento e não executa crawler. O arquivo de entrada antigo também foi substituído por um aviso sem coleta.
4. Aguarde a primeira execução do Cron. Ela cria automaticamente as tabelas `focus_*` no banco existente e salva o cursor da última operação da carteira de migração.
5. Verifique `/live`: a resposta deve ter `version: 39`, `startedAt` e depois `checkedAt` avançando. A página informa atraso ou falha em vez de apresentar uma coleta parada como atual.

Não exclua o banco, o KV nem os checkpoints antigos. Esta versão não depende de GitHub Actions. Publicar somente um HTML não ativa o novo coletor; é necessário publicar o Worker gerado. Se você cola worker.js no painel, mantenha o Cron e o binding DB configurados. As novas variáveis são `FOCUS_DAILY_WRITE_BUDGET=85000` e `FOCUS_HISTORY_WRITE_BUDGET=5000`, também valores padrão do código.

## Novo período de acompanhamento

Os contadores começam em zero na primeira ativação da v36 e acumulam somente migrações observadas depois do cursor inicial. Não são os totais históricos globais da Pi Network. O horário inicial aparece na home. O início é a ativação, não a meia-noite.

Dados anteriores permanecem nas tabelas antigas, mas não são somados aos novos contadores. Evidências históricas compatíveis já armazenadas são reutilizadas para classificar novas migrações. A implantação não reprocessa os antigos 15 dias nem tenta recuperar a antiga fila atrasada. Reimplantar a v36 preserva o período e o cursor; não começa do zero novamente.

O Top 20 soma todos os recebimentos observados por carteira na janela de sete dias. Nas primeiras semanas ou durante atrasos a cobertura é identificada como parcial. Os contadores confirmados são cumulativos e não expiram; o Top 20 é móvel. Os registros continuam armazenados quando saem do ranking.

## Trabalho removido da execução

Não há coleta de saldos de destinatários, análises de duração de bloqueios, médias, medianas, volumes gerais, distribuições, gráficos, indexação global ou recuperação automática dos 15 dias. Apenas o saldo da origem é consultado a cada cinco minutos. A home consulta somente `/live`. As rotas antigas `/stats`, `/d1/*`, `/wallet-balances` e `/horizon/*` retornam 410; não consultam bancos nem a blockchain. O código anterior foi arquivado em `legacy/` para referência e não é incluído no Worker.

Guardar o valor dos lockups ainda é necessário para ordenar o Top 20. IDs das operações ficam junto ao evento; não há uma segunda gravação de cada operação em um arquivo global. Uma página é agregada por destinatário e transação e gravada em lote com o cursor e os contadores, de forma atômica.

## Confirmação

Primeira migração: criação da mesma carteira pela origem de migração no mesmo hash, ou histórico válido desde a criação mostrando essa posição. Segunda migração: segundo hash de migração no histórico contínuo dessa carteira. Quantidade de lockups e idade da carteira não determinam a posição.

Quando falta evidência, apenas o histórico da carteira que recebeu uma nova migração é consultado, em páginas salvas e retomáveis. Até quatro páginas de verificação são processadas por execução, depois da coleta recente, dentro da reserva de orçamento. A falta de confirmação não impede que o recebimento apareça no Top 20. Carteiras com origem não verificável ou destinatários ambíguos não são convertidas em segunda migração por dedução.

Uma carteira pode estar nos dois contadores se receber ambas as migrações durante o período. Migrações posteriores podem aparecer no Top 20, mas não aumentam os dois contadores. Recibos com destinatário ambíguo são excluídos da atribuição, não contados como pessoas.

## Frequência e limites

Cron: uma vez por minuto, até três páginas de 200 operações da origem por execução, com limite de tempo para a coleta. Site: consulta a cada 20 segundos enquanto visível. Top 20: resultado recalculado a cada cinco minutos. Essas frequências não garantem ausência de atraso em picos ou quando a API está indisponível.

O D1 continua tendo as cotas do plano contratado. Há orçamento conservador de 85.000 linhas escritas por dia para esta coleta, incluindo uma reserva de até 5.000 para verificação. O consumo conhecido da coleta antiga no mesmo dia é carregado uma única vez na ativação, sem zerar artificialmente a cota. Outros processos na conta podem consumir recursos fora desse controle. Se o orçamento acabar, o cursor é preservado e a home informa a pausa. Esta simplificação reduz trabalho, mas não promete coleta ilimitada gratuita.

O Top 20 ainda lê os eventos dos sete dias para ordenar valores. Só a contagem cumulativa é incremental; não foi implementado um ranking materializado permanente.

## Desenvolvimento e validação

`node src/build.mjs` gera worker.js sem incluir o código antigo.

`node focus-tests.mjs` requer Node 24 com SQLite integrado. Testa limite inicial sem backfill, lockups combinados, confirmação direcionada, reexecução sem duplicação, rollback de dados/cursor/contadores, terceira migração, destinatário ambíguo, falta de origem, ranking semanal, preservação dos totais e bloqueio de concorrência.

Nenhum dado de produção foi alterado nesta sessão. Não houve medição de consumo na sua conta Cloudflare.
