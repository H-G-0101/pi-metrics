# v34 — Migration counts and Top 20 take priority

## Instalação

Publique o projeto completo com o wrangler.toml incluído, preservando o segredo STATS_TOKEN. O binding DB e o Cron de um minuto continuam no arquivo. Publicar somente worker.js não atualiza as variáveis de orçamento. Atualize também .github/workflows/crawl.yml no GitHub para aplicar a reserva menor do histórico. Uma execução já em andamento mantém suas configurações anteriores.

Não apague o banco nem os checkpoints. O coletor retoma o cursor existente, inclusive se houver uma fila acumulada. Não é necessário iniciar uma Action para ativar a coleta frequente: ela depende do Cron do Worker.

## Prioridades

- Migrações novas: até seis páginas de 200 operações por execução, dentro de 45 segundos de coleta. O cursor só avança junto com a gravação concluída.
- Recuperação anterior à ativação: no máximo uma página, somente depois de alcançar a ponta da fila. Reserva diária de 3.000 gravações, incluída no orçamento principal; pausa ao atingir metade do orçamento principal.
- Orçamento principal: 65.000 linhas escritas por dia; histórico: 15.000. Não há reset artificial do consumo ao publicar. A reserva antiga não pode bloquear as novas operações com um erro de orçamento de backfill.
- As operações continuam arquivadas e deduplicadas. A soma dos lockups agora atualiza cada evento uma vez por página, eliminando as atualizações repetidas do trigger antigo. A substituição ocorre sob o mesmo bloqueio de execução, e as gravações e cursor permanecem na mesma transação.
- Top 20 da coleta frequente: calcula todas as carteiras observadas na janela de sete dias, agrupa todos os seus recebimentos e publica um resultado a cada cinco minutos. Não é uma lista das vinte últimas operações. Uma falha do ranking não impede a publicação dos contadores.
- A tela mantém a opção Historical report, com os detalhes de bloqueios já existentes. As duas fontes não são somadas: suas coberturas podem se sobrepor. O ranking frequente mostra explicitamente cobertura parcial até haver sete dias cobertos. Seus detalhes de bloqueios dependem do relatório histórico.
- O relatório histórico, volumes e gráficos são consultados pelo navegador a cada cinco minutos; sua coleta histórica continua agendada a cada seis horas. O resumo frequente continua sendo consultado a cada vinte segundos.
- K/M permanecem nos indicadores, sem símbolo antes do número. Dados parciais permanecem identificados no texto.

## Precisão e limites

Um evento continua sendo destinatário + hash distinto; os lockups do mesmo evento são somados. Recebimento observado não significa segunda migração confirmada. A confirmação de primeira, segunda ou posterior depende da evidência histórica validada, e pode continuar pendente. A redução do orçamento histórico pode prolongar essa confirmação.

O volume de Pi vem das mesmas operações usadas para contar e ordenar migrações: deixar sua exibição mais lenta, por si só, não elimina essas gravações necessárias. Esta versão reduz atualizações repetidas e redistribui o orçamento, mas não garante coleta ininterrupta em qualquer volume de tráfego. O plano Free do D1 possui limites compartilhados de 100.000 linhas escritas e 5 milhões de linhas lidas por dia. Consultas de classificação e ranking também consomem leituras; em janelas grandes podem exigir ajuste adicional ou outro plano. Fonte: https://developers.cloudflare.com/d1/platform/pricing/

Os orçamentos são controles por coletor, não uma medição global da conta Cloudflare. Uma Action antiga em execução pode ainda usar o orçamento anterior. Os limites reais do provedor permanecem aplicáveis.

## Validação

Passaram os testes do histórico, as três amostras reais previamente arquivadas e os testes SQLite de coleta incremental. Estes verificam soma de lockups em páginas diferentes, replay sem duplicação, rollback e retomada de cursor, exclusão de destinatário ambíguo, evidência confirmada, bloqueio de execuções simultâneas, reserva de backfill esgotada sem bloquear novas migrações, seis páginas de recuperação da fila, ranking de 25 carteiras com corte correto em 20 e cobertura parcial explícita.

Worker regenerado e sintaxe do JavaScript da home verificada. Não houve publicação nem teste de carga na conta Cloudflare do usuário.
