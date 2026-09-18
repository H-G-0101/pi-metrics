# Pi Migration Monitor — v41

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
