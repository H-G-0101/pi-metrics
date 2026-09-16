# Pi Migration Monitor — v36

Versão enxuta: carteiras com primeira migração confirmada, carteiras com segunda migração confirmada e Top 20 por Pi recebido nos últimos sete dias. Interface em inglês, números K/M, cópia de endereço, horário da última coleta e pendências de classificação.

## Instalar

1. Atualize o repositório com o pacote completo, incluindo `.github/workflows/crawl.yml`, `wrangler.toml`, `worker.js` e `src/`.
2. Publique o Worker com o wrangler.toml. O binding `DB` continua apontando para `pi-migrations`; o Cron continua `* * * * *`.
3. Se uma Action antiga ainda estiver rodando, cancele essa execução uma vez. O novo workflow não tem agendamento e não executa crawler. O arquivo de entrada antigo também foi substituído por um aviso sem coleta.
4. Aguarde a primeira execução do Cron. Ela cria automaticamente as tabelas `focus_*` no banco existente e salva o cursor da última operação da carteira de migração.
5. Verifique `/live`: a resposta deve ter `version: 36`, `startedAt` e depois `checkedAt` avançando. A página informa atraso ou falha em vez de apresentar uma coleta parada como atual.

Não exclua o banco, o KV nem os checkpoints antigos. Esta versão não depende de GitHub Actions. Publicar somente um HTML não ativa o novo coletor; é necessário publicar o Worker gerado. Se você cola worker.js no painel, mantenha o Cron e o binding DB configurados. As novas variáveis são `FOCUS_DAILY_WRITE_BUDGET=85000` e `FOCUS_HISTORY_WRITE_BUDGET=5000`, também valores padrão do código.

## Novo período de acompanhamento

Os contadores começam em zero na primeira ativação da v36 e acumulam somente migrações observadas depois do cursor inicial. Não são os totais históricos globais da Pi Network. O horário inicial aparece na home. O início é a ativação, não a meia-noite.

Dados anteriores permanecem nas tabelas antigas, mas não são somados aos novos contadores. Evidências históricas compatíveis já armazenadas são reutilizadas para classificar novas migrações. A implantação não reprocessa os antigos 15 dias nem tenta recuperar a antiga fila atrasada. Reimplantar a v36 preserva o período e o cursor; não começa do zero novamente.

O Top 20 soma todos os recebimentos observados por carteira na janela de sete dias. Nas primeiras semanas ou durante atrasos a cobertura é identificada como parcial. Os contadores confirmados são cumulativos e não expiram; o Top 20 é móvel. Os registros continuam armazenados quando saem do ranking.

## Trabalho removido da execução

Não há coleta de saldos disponíveis, análises de duração de bloqueios, médias, medianas, volumes gerais, distribuições, gráficos, indexação global ou recuperação automática dos 15 dias. A home consulta somente `/live`. As rotas antigas `/stats`, `/d1/*`, `/wallet-balances` e `/horizon/*` retornam 410; não consultam bancos nem a blockchain. O código anterior foi arquivado em `legacy/` para referência e não é incluído no Worker.

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
