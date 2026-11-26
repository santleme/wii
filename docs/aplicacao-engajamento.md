# Aplicação da pesquisa de engajamento nos jogos

Data: 2026-11-25
Pergunta: como traduzir mecanismos de engajamento saudável para uma web estática sem backend, sem duplicar PRs já abertos?

## Resumo executivo

As duas pesquisas (`pesquisa-engajamento-jogos.md` e `pesquisa-engajamento-plataformas-esports.md`) convergem nos mesmos mecanismos de maior evidência/custo: objetivos proximais, feedback específico e imediato, progressão persistente, comparação contra o próprio histórico, dificuldade adaptativa transparente, reinício rápido e ausência de punição por pausa. A implementação atual aplica esse subconjunto à corrida e ao tênis.

## Limite de não-duplicação

- **PR #21/#22**: calibração e detecção pelo torso não foram reimplementados neste trabalho.
- **PR #23 (`feat/tennis-wii-sports`)**: já continha o tênis por timing, balística, adversário, rewind da bola e correções de latência do pipeline de swing. O trabalho de engajamento foi feito **em cima** dessa base, não como uma segunda implementação do tênis.
- Integração de mãos/fingers e roteamento automático de esporte continuam fora deste escopo.

## O que foi aplicado

### Corrida

1. **Run com falha e reinício rápido**: tropeços descontam pontos, a run termina quando a pontuação zera e o fluxo de reinício por remontagem continua intacto.
2. **Combo e consequência**: barreiras limpas aumentam combo e bônus; colisão zera o combo, reduz velocidade apresentada e produz solavanco visual.
3. **Recorde pessoal e goal-gradient**: recorde persistente e distância para o recorde visível durante a run.
4. **Resumo acionável de fim de run**: pontos, combo máximo, XP e destaque de recorde/rank, ao lado — não misturado — do ranking local de melhores runs.
5. **Missão diária determinística**: uma missão local por data, sem streak e sem punição; progresso visível e recompensa pequena de XP.
6. **Sequência de obstáculos semeada**: a sequência de tipos/raias é repetível no dia porque o spawn atual já recebe RNG injetável; o ritmo de aproximação continua dependendo do movimento do jogador.

### Tênis

1. **Progressão persistente**: desempenho da partida vira score local; XP e ranks são compartilhados com a infraestrutura comum.
2. **Resumo específico de partida**: desempenho, pontos vencidos/perdidos, melhor rally, XP, recorde e rank.
3. **Recorde pessoal e goal-gradient**: distância para o recorde aparece durante a partida.
4. **Missão diária determinística**: missões de desempenho, rally ou vitória; sem streak e sem punição.
5. **Transparência adaptativa**: a HUD mostra o nível atual do adversário em vez de esconder a rubber-band.
6. **Reinício sem punição**: partidas reiniciam automaticamente e o ciclo de pontos pode ser interrompido sem custo de progressão.
7. **Feedback temporal**: início da raquetada já produz animação/som; contato, quique, erro, ponto, game, partida, missão, recorde e rank têm consequências audiovisuais distintas.

### Adaptações à arquitetura atual

- A corrida preserva o spawn, o ranking top-N e o fluxo de reinício da arquitetura atual; o antigo `TrackDirector` e o modelo de três vidas não foram portados.
- Na corrida atual, uma colisão que zera a pontuação encerra a run. Por isso a pontuação gravada para ranking, recorde e XP é o pico da run — o valor vivo no encerramento seria sempre zero.
- O tênis preserva o `Math.random` existente para saques/decisões; a seed diária foi aplicada apenas à corrida, onde o spawn já expõe o RNG como dependência explícita.

### Infraestrutura comum

- `progression.ts`: ranks por XP e registro de resultado sem mutar estado anterior.
- `progressStore.ts`: persistência local versionada com fallback em memória quando `localStorage` falha.
- `missions.ts` + `missionStore.ts` + `missionTracker.ts`: missões determinísticas por data, progresso vivo por tentativa e persistência apenas de conclusão.
- `seededRandom.ts`: RNG semeado, explicitamente não criptográfico.
- `hud.ts` + `GameCanvas`: recorde, rank, barra de progresso, missão, detalhe acionável e feedback transitório.
- `audio.ts`: eventos de consequência (sucesso, falha, milestone, quique, raquetada), com mudo persistente.

## Compromissos éticos implementados

- Sem streak diário, energia, loot box, notificação ou punição por pausa.
- Missão é opcional e desaparece sem custo; não há contador de dias consecutivos.
- A adaptação é visível na HUD; não é apresentada como matchmaking humano.
- O reinício rápido não impede descanso: na corrida a pista não avança sem movimento; no tênis o saque pode ser adiado sem penalidade.
- Progressão celebra mestria pessoal; não usa comparação social obrigatória.

## Verificação

Última verificação local após a implementação:

- `npm test`: 46 arquivos, 402 testes passando.
- `npm run lint`: sem erros.
- `npm run build`: sucesso.

## Próximos passos por evidência/custo

1. **Fantasma da melhor corrida** usando a seed e/ou gravação compacta de inputs.
2. **Arquivo pessoal multi-métrica** estilo “Best Efforts”: distância, combo, rally, desempenho e vitórias separados.
3. **Cartão compartilhável estilo Wordle** via texto/canvas e Web Share API.
4. **Modo zen / adaptação com opt-out** explícito, em vez de apenas transparência.
5. **Cooperação local assíncrona** antes de competição social direta, seguindo a evidência específica de exergames.
