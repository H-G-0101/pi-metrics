# v35 — Contadores incrementais e retomada dos 15 dias

## Publicação

Publique o pacote completo no Worker e atualize o código do repositório GitHub. Preserve DB, STATS_TOKEN, wrangler.toml e os arquivos de checkpoint. A coleta frequente continua no Cron de um minuto; o Top 20 mantém o cache de cinco minutos. A próxima Action passa a utilizar a retomada recente. Uma Action já em execução utiliza o código antigo.

Na primeira coleta após a atualização, o Worker adiciona uma coluna de classificação aos eventos existentes, cria um índice para localizar evidências alteradas e inicializa o resumo de 24 horas. Essa inicialização faz uma leitura completa uma vez. Nas coletas seguintes não há uma nova soma completa da janela para os contadores.

O cache recente dos 15 dias só passa a existir com esta versão. Portanto, a primeira recuperação ainda precisa buscar os dados ausentes, respeitando o limite de páginas; as seguintes retomam os cursores e dados salvos. Não apague checkpoint.json.parts: ela contém também o novo cache.

## Contadores

- As operações novas são deduplicadas pelos IDs existentes e somadas por destinatário + hash. Os deltas atualizam eventos, carteiras, primeiras, segundas, posteriores, pendentes e volume exato.
- Operações, evento agregado, resumo e cursor são gravados na mesma transação. Um erro não avança o cursor nem acrescenta o recebimento aos contadores.
- A expiração consulta somente os eventos que saíram desde o limite anterior das 24 horas. Esses eventos permanecem arquivados; somente sua contribuição ao resumo móvel é removida.
- Novas evidências são processadas em lotes de até 25 carteiras por coleta, com cursor persistido. A classificação pode ser confirmada ou retirada quando a evidência muda. Os eventos novos consultam a evidência disponível imediatamente.
- A classificação ainda depende de histórico válido. Não se presume segunda migração pela idade da carteira ou quantidade de lockups.

## Recuperação recente

- Um cursor acompanha operações novas em ordem crescente; outro continua a recuperação antiga em ordem decrescente. Cada atualização prioriza o cursor novo e usa até 200 páginas no total.
- Os eventos, a evidência de criação de conta e ambos os cursores ficam em arquivos divididos em lotes de 1.000 registros. O manifesto só é substituído depois que todas as partes foram escritas.
- Há salvamento periódico, ao terminar ou falhar e durante o checkpoint geral. Uma interrupção permite retomar o último lote completo. Se o cache estiver ausente ou inválido, a recuperação recomeça com indicação no log, sem confiar em um cursor sem os dados correspondentes.
- Dados que saem dos 15 dias deixam apenas este cache móvel. O índice histórico e o arquivo permanente do D1 permanecem separados.

## Saldo disponível

O saldo disponível usa cache de 30 minutos no navegador e no Cache API do Worker. A resposta informa o horário original da consulta; reutilizar o cache não muda esse horário. O cache do Worker depende da disponibilidade na região e pode ser removido antes do prazo. Não usa novas gravações no D1 ou KV.

O Top 20 continua ordenado pelo Pi recebido, não pelo saldo disponível. A interface identifica o cache na coluna de saldo e mostra a hora da consulta ao passar o mouse.

## Limites e testes

A versão reduz a releitura dos contadores, mas não elimina o custo de arquivar operações nem o cálculo do Top 20. Os orçamentos da v34 permanecem aplicáveis. Não foi medido o consumo real na conta do usuário e não há garantia de coleta ilimitada no plano gratuito.

Testes executados: live-tests.mjs (incluindo comparação com soma completa de referência, expiração, reclassificação e rollback); recent-tests.cjs (retomada após reinício, cursor antigo/novo, lockups em páginas diferentes, falha de rede e página inválida); balance-cache-tests.cjs (cache entre requisições e expiração); audit-tests.cjs; real-sample-tests.cjs. Worker regenerado e scripts da home verificados sintaticamente. Sem publicação em produção nesta sessão.
