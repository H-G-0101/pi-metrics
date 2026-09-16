# v28 — histórico permanente e evidências

## Publicar

Substitua os arquivos pelo pacote completo. Publique primeiro o Worker usando o wrangler.toml incluído, preservando DB, STATS e STATS_TOKEN. Execute depois **Crawl Pi migrations**. Não apague banco ou checkpoints. O Worker cria automaticamente a tabela nova.

Confira `releaseVersion: 28` em `/stats`. A atualização visual chega com o Worker; as evidências chegam após a publicação do crawler. O agendamento existente de seis horas permanece.

## Histórico de eventos

A tabela `migration_operations` guarda cada operação nativa da origem monitorada com ID único, carteira, hash, data, valor decimal em texto e predicado do bloqueio. Reprocessar a mesma operação não duplica valores. Um evento é o grupo carteira + hash, mesmo quando seus bloqueios atravessam páginas diferentes.

O registro permanente começa nas páginas históricas processadas a partir desta atualização e também recebe o histórico recuperado das carteiras do Top 20. Não existe varredura retroativa instantânea de todo o banco antigo nem promessa de cobertura integral. Os registros novos não são eliminados ao sair dos 15 dias. Os totais Lifetime continuam usando o índice persistente de carteiras.

Cada página histórica grava operações, carteiras e cursor na mesma requisição transacional. A verificação de carteira grava operações e seu ponto de retomada juntos. As novas escritas participam do orçamento D1 e podem reduzir o avanço diário disponível no plano atual.

## Verificação do Top 20

O crawler percorre operações da conta em ordem crescente. Exige evidência da criação da conta no início do histórico para ordenar suas migrações. Confere origem, destinatário e ativo nativo; ignora operações explicitamente malsucedidas. Dois bloqueios no mesmo hash continuam sendo um evento.

Há um limite de 100 páginas por carteira por passagem. O cursor e as evidências ficam no checkpoint e no D1 para continuar na próxima passagem. Erros de consulta não viram prova de ausência de migrações. O histórico verificado pode corrigir a rodada exibida no Top 20, inclusive terceira e posteriores. Não sobrescreve automaticamente os registros Lifetime antigos que ainda precisam de revisão.

## Visual

- “View evidence” nas carteiras: fundamento, hash, data, migração anterior quando disponível e data da verificação.
- Verde para evidência confirmada; âmbar para pendência. Detalhes acessíveis no celular.
- Bloqueios mostram duração original, data UTC e tempo restante. Prazo encerrado não significa saldo resgatado.
- Totais Lifetime sem abreviação. Grupos de carteira e bloqueios preservam a mesma cor alternada.

## Validação

`node src/build.mjs` gera o Worker. `node audit-tests.cjs` testa classificação, ausência de evidência, agrupamento, persistência, cotas, retomada incremental de histórico e correção de um evento antigo para terceira migração. Os scripts embutidos também foram verificados sintaticamente.

Não houve deploy ou acesso autenticado à produção. Renderização em navegador não foi validada neste ambiente. A nova evidência depende de operações disponibilizadas pelo Horizon; não é certificação oficial da Pi Network.
