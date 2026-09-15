# v29 — precisão e validação

## Instalação

Publique o Worker atualizado e depois execute **Crawl Pi migrations** com este crawler. Preserve DB, STATS, STATS_TOKEN e os checkpoints. Confira `releaseVersion: 29` em `/stats`.

## Correções

- Destinatário: a operação só é atribuída quando existe exatamente um candidato além da origem e recuperação. Casos ambíguos ficam excluídos das somas atribuídas, com contagem e amostras de IDs/hashes no relatório. A home exibe o aviso. Não se escolhe arbitrariamente a primeira carteira.
- Histórico ambíguo: se encontrado durante a verificação da carteira, impede afirmar a rodada pelo índice antigo. Evidências da versão anterior são revalidadas uma vez com a política 29, sem apagar o D1.
- Bloqueios: avaliação booleana de unconditional, abs_before, rel_before, not, and e or por intervalos. Ramos desconhecidos nunca são descartados silenciosamente. Uma data de desbloqueio é exibida apenas quando existe um único intervalo contínuo até o futuro; janelas limitadas, condições não reconhecidas e casos impossíveis ficam sem data simples. Isso não certifica o resgate.
- Valores: valores decimais são convertidos para unidades inteiras de 0,0000001 Pi com BigInt. As somas de eventos, ranking, dias, volumes e distribuições preservam campos decimais `*Exact`. Campos numéricos existentes continuam para gráficos; médias, percentuais e apresentação são arredondados.
- Cobertura: além do Top 20 semanal, até 20 outras carteiras da janela recente entram em uma fila circular por passagem. A fila e os cursores persistem. Não representa uma auditoria instantânea de todas as carteiras Lifetime.

## Verificação real em 15/09/2026

A consulta de 200 operações da origem trouxe 168 create_claimable_balance, 13 create_account e 19 payments. Foram examinados os históricos disponíveis de três destinatários da amostra, todos iniciando com a criação da conta e terminando antes do limite de 200 registros:

| Carteira | Operações no histórico | Rodada do evento recente |
|---|---:|---:|
| GDTHYIIV27UIIP6R4S6XMH53PRHZNUNHFJURHKEIZM4TAZVIPUIH6OUX | 4 | 1 |
| GBUZKIRZWM3YVDUYHLUFZ6CKBP5LPVK3C7GRKKYQJH44GTNC33TO5UUX | 3 | 2 |
| GAQELXP2IXPZTRB6AIM7L6UVRB2O7UJZKTNU2ZQEYCC374CNE4GBYW4K | 5 | 2 |

O hash recente compartilhado é `97a5a3697c48c0e4aa4110af1f76d85eba2e2d4f5487fa15ac29148f0cad5712`: uma mesma transação envolve destinatários com rodadas diferentes. O agrupamento precisa usar carteira + hash.

Fonte: https://api.mainnet.minepi.com/accounts/GABT7EMPGNCQSZM22DIYC4FNKHUVJTXITUF6Y5HNIWPU4GA7BHT4GC5G/operations?order=desc&limit=200 e históricos `/accounts/{carteira}/operations?order=asc&limit=200`.

As operações dos três históricos estão em `real-sample-v29.json`. `node real-sample-tests.cjs` reproduz as três classificações sem depender da rede. Essa pequena amostra não é aleatória e não estabelece percentual geral de precisão. Terceiras migrações e ambiguidades foram testadas com casos construídos, não identificadas nesta amostra.

## Testes

Execute `node src/build.mjs`, `node audit-tests.cjs` e `node real-sample-tests.cjs`.

Incluem condições combinadas, ramo desconhecido, janela limitada, negação dupla, destinatário ambíguo, somas além do limite seguro de Number, retomada, cota e agrupamento. Sem publicação ou alteração de dados de produção. Registros antigos do índice Lifetime não foram certificados retroativamente.
