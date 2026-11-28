# Design do tênis estilo Wii Sports — Baseline Rally

Data: 25 de novembro de 2026 · Documento de design para reescrita do `TennisGame`. Deriva da análise de gargalos feita em sessão (ver `analise-gargalos-corrida.md` para o pipeline genérico) e das pesquisas de CV em `docs/`. Separa claramente o que é **fato verificado no código**, o que é **conhecimento do domínio** e o que é **decisão de design**.

---

## 1. O que é o Wii Sports Tennis, mecanicamente

Conhecimento de domínio sobre o original (Wii, 2006):

1. **O jogador não controla movimentação** — o Mii corre sozinho até a bola. A única habilidade é o swing.
2. **Direção = timing**: o mesmo swing natural manda a bola cruzada (contato cedo, à frente do corpo) ou paralela (contato tarde, atrás). Não existe "mira com o braço".
3. Potência importa menos que timing; bola rápida demais é risco de erro, não só virtude.
4. Saque: flick para cima lança a bola, swing no ápice define a qualidade.
5. Forehand/backhand são inferidos do lado do gesto; o jogo é generoso com janelas — é arcade.
6. Não há spin por torção de punho que importe materialmente para o core loop.

## 2. Restrições do nosso sensor — o que dá e o que não dá para copiar

Fatos verificados no código e nas medições de `pesquisa-pipeline-cv.md` §7.5:

| Capacidade | Estado | Consequência para o design |
|---|---|---|
| Instante do pico do swing (`peakTimestampMs`) | **Bom** — quantização de ±16-33 ms a 30 fps, timestamps monotônicos | A mecânica central (timing) vive no nosso melhor canal — mesmo acaso feliz do Wii |
| Lado do swing (forehand/backhand) | **Bom** — sinal lateral forte | Autenticidade barata: direção espelha no backhand como no tênis real |
| Velocidade de pico | **Grosseiro mas utilizável** — diferenças finitas de posição filtrada | Potência em 3-4 níveis, não contínua fina |
| Altura do contato (y do punho no pico) | **Utilizável** — landmark estável | Smash/voleio emergem de graça |
| vy no pico (subindo/descendo) | **Utilizável como proxy** | Topspin/slice cosmético-físico no bounce |
| Posição lateral precisa do punho | **Ruidoso** — e a mira atual usa isso | **Abolir mira por posição; adotar mira por timing** |
| Profundidade (z) | **O mais ruidoso** — monocular | Não usar z para nada crítico |
| Orientação do punho/spin por torção | **Impossível** | Não faz parte do core loop nem no Wii original — ignorar |
| Latência fóton→evento confirmado | **~100-500 ms** — pipeline + confirmação + arbitragem | Exige adjudicação retroativa (§4) — o coração deste design |
| Latência até *onset* do swing | **~50-100 ms** — um frame após cruzar o limiar | Canal precoce para animação (`swing-start`) |

Restrições físicas que não se resolvem em software: motion blur do punho rápido em webcam de ambiente (exposição 15-33 ms/frame), oclusão do punho pelo torso no backswing, teto de 30-60 fps da câmera. O design assume que **swings ocasionalmente se perdem** — nenhum swing perdido pode custar um ponto de forma injusta: as janelas de contato são generosas e o whiff é sempre culpa visível do jogador (bola passou), nunca do detector.

## 3. O jogo

### 3.1 Quadra e geometria

Unidades aproximadamente métricas, escala arcade comprimida:

```
z = -10 ───────── baseline do oponente
z = 0   ═════════ rede (altura 0,9 no centro)
z = +10 ───────── baseline do jogador
x ∈ [-3,5, +3,5]  singles (laterais)
```

- Avatar do jogador em z ≈ +8,3; oponente em z ≈ -8,3.
- **Plano de contato** z_contact = +7,2 (à frente do jogador); o oponente tem o seu em -7,2.
- Alcance lateral do avatar: raio de alcance ~1,15 u a partir do centro do corpo.

### 3.2 Movimentação automática (como no Wii)

O avatar corre sozinho: intercepta lateralmente a projeção da bola com velocidade máxima ~5,5 u/s. O jogador real **não precisa se mexer** — e o design não usa lane-lean no tênis. A largura do placement do oponente pressiona indiretamente: se o avatar ainda está se deslocando quando a bola chega, a qualidade máxima do retorno cai (cap de potência) — é assim que bolas abertas ficam difíceis sem nunca serem impossíveis.

### 3.3 Máquina de estados do rally

```
SERVE_TOSS ──swing──> adjudica saque ──> RALLY (bola viva)
    │miss (bola cai)                         │
    └─ re-toss (sem penalidade)              ├─ bola em voo para o oponente → AI retorna ou erra
                                             ├─ bola em voo para o jogador → swing ou passa
                                             └─ bola quica 2×, sai, ou rede → POINT_OVER
POINT_OVER ──> placar (15/30/40/game) ──> próximo saque (alterna por game)
MATCH_OVER ──> tela de resultado ──> reinício automático
```

Regras arcade simplificadas (decisões de design):

- **Sem service box nem dupla falta**: o saque vale como qualquer bola — precisa passar a rede e cair na quadra. Errar o toss não penaliza: re-toss infinito com dica na HUD. (Service box é trabalho de geometria sem ganho de showcase.)
- Volley permitido: bola sem quica pode ser contatada — timing igual.
- Uma quica no máximo, como no tênis real; a segunda quica encerra o ponto.
- Placar clássico 15/30/40/deuce/vantagem por game; games alternam o sacador; match = melhor de 3 games (configurável), com reinício automático.

### 3.4 Adjudicação de contato — o coração do design

**Problema**: o evento de swing chega 100-500 ms depois do contato físico real. Se o jogo consultar a posição atual da bola quando o evento chega, o timing está corrompido.

**Solução — adjudicação retroativa**: a trajetória da bola é balística e perfeitamente conhecida. Quando o evento chega:

1. `t_peak = event.peakTimestampMs` — o instante físico do contato (estimativa do detector).
2. Retrocede a bola analiticamente a `t_peak`: posição, velocidade, quantas quicas já houve.
3. `timingError = t_peak − t_ideal`, onde `t_ideal` é o instante em que a bola cruza o plano de contato em altura golpeável (0,4-2,2 u).
4. Janelas (arcade, generosas — decisão de design afinável):
   - `|timingError| ≤ 500 ms` e bola ao alcance lateral (≤2,2 u) e não morta (sem segunda quica, não passada) → **contato**.
   - Fora disso → **whiff** (a bola segue viva; o ponto se resolve pela física).
5. Direção do retorno: mapeamento contínuo `timingError → ângulo lateral` com sinal dependente do lado do stroke — cedo → cruzada, tarde → paralela; no backhand espelha, como no tênis real. `timingError` extremo (>~350 ms) manda a bola tão aberta que sai — o erro nasce da geometria, não de regra especial.
6. Potência: `power01` do evento modula a velocidade de saída (11-20 u/s). Cap reduzido se o avatar estava em deslocamento. Bola alta (acima do ombro no contato) vira smash: ângulo para baixo, bônus de velocidade.
7. Spin: vy do punho no pico — subindo forte = topspin (quica kickando para cima/frente), descendo = slice (quica rasteiro). Efeito físico **apenas no bounce** — visível e honesto.

**Rewind visual**: no instante da adjudicação, a bola é reposicionada no ponto de contato com a nova velocidade **avançada pelo delta** (t_now − t_peak), para que a posição renderizada seja a que a bola de saída teria agora. Há um pop de 1-2 frames — mascarado pelo som de contato e pela animação de swing do avatar, que começou no `swing-start` (§3.5). É o mesmo cheat de todo netcode retroativo e de todo jogo de câmera.

**O que acontece quando o detector perde um swing**: a bola passa e o ponto se resolve pela física — indistinguível de um whiff real. Aceitável porque raro; inaceitável seria o inverso (swing fantasma), que o detector já evita por design.

### 3.5 O canal precoce: evento `swing-start`

Novo evento do pipeline, emitido no frame em que o swing cruza o limiar de onset (antes de qualquer confirmação — pode ser abortado e não vira swing confirmado). Latência ~50-100 ms vs. ~150-500 ms do confirmado. Usos:

- **Animação do avatar**: o windup+stroke procedural (~300 ms) começa no onset — quando a adjudicação chega, a raquete já está no meio do movimento e o frame de contato cai sincronizado com o snap da bola. É o que fecha a ilusão de causalidade.
- Não usado para adjudicação: é sinal não confirmado; backswings e ajustes de braço disparam também — visualmente inofensivo (parece preparação).

### 3.6 Balística alvo — como se constrói a trajetória de saída

Em vez de empurrar velocidades e torcer, **resolve-se a trajetória para um alvo** (técnica padrão de arcade, determinística e testável):

1. Escolhe-se o alvo de quique `(x_t, z_t)`: lateral do timing (contínuo, clamp ±20°), profundidade da potência (mais forte = mais fundo/rápido), mais um jitter pequeno com seed determinístico.
2. `T = (z_contato − z_t) / v_forward` — tempo de voo imposto pela velocidade escolhida.
3. `vx = (x_t − x_0)/T`, `vy = (gT²/2 − y_0)/T` — solução exata do projétil para `y(T) = 0` com gravidade g.

Consequências emergentes sem regra especial: bola forte sai rasa (risco de rede em contato baixo — física real); ângulos extremos saem pela lateral; smash em bola alta aponta para baixo e é quase indefensável. A rede é uma colisão física no plano z=0 com altura 0,9 — bater nela encerra o ataque como no tênis.

### 3.7 Oponente AI

- **Movimento**: intercepta a projeção da bola no seu plano com velocidade máxima ~5 u/s; retorna ao centro depois do golpe.
- **Devolução**: quando a bola entra na sua janela, gera retorno por balística alvo para um ponto no lado do jogador. Placement com variância controlada pela dificuldade; velocidade e profundidade idem.
- **Erro**: chance de erro (rede/fora) cresce com a qualidade da bola recebida (velocidade + largura + smash). Dificuldade rampa suave com os games — começa generosa (bolas centrais e lentas) para o jogador aprender o timing.
- Winners acontecem quando a bola é rápida e aberta: o avatar do jogador não chega a tempo e o cap de qualidade cai — mas o ponto nunca é impossível, porque alcance é garantido salvo combinação extrema (decisão arcade).

### 3.8 HUD, áudio e feedback

- Placar tênis real: games + pontos correntes (15/30/40/AD), indicador de quem saca.
- Feedback de timing a cada contato: `CEDO`/`PERFEITO`/`TARDE` + direção resultante — ensina a mecânica central.
- Mensagens de estado: prompt de saque, whiff (`bola passou!`), rede, fora, game/match.
- Som de contato existente (`audio.hit(power)`) dispara na adjudicação; bounce e saque podem reusar `step`/`jump` — sem novos assets.

### 3.9 Teclado (modo dev/teste sem câmera)

Espaço dispara um swing sintético com `peakTimestampMs = agora` — ou seja, **o timing do teclado é autêntico**: apertar cedo cruza, tarde paralela. Power fixo 0,65 (shift+espaço = 1,0). É suficiente para validar todo o jogo sem webcam — e é como o showcase se demonstra em máquina sem câmera boa.

## 4. Arquitetura da implementação

### Módulos puros (sem Three.js — testáveis em Vitest, TDD estrito)

| Módulo | Responsabilidade |
|---|---|
| `src/games/tennis/tennisScore.ts` | FSM de placar 15/30/40/deuce/game/match, alternância de saque |
| `src/games/tennis/ballistics.ts` | Projétil: `advance` (posição/velocidade em t), `timeAtPlane`, `bounce`, `solveOutgoing` (alvo → velocidade) |
| `src/games/tennis/contactAdjudicator.ts` | Retrocesso da bola a `t_peak`, janelas, timingError → direção/potência/qualidade, whiff |
| `src/games/tennis/opponentAi.ts` | Alvo de movimento, geração de devolução, modelo de erro e dificuldade |

`TennisGame.ts` fica com cena Three.js, máquina de estados, animações e HUD — integração fina sobre os módulos.

### Mudanças no pipeline de sensing

> Nota de arquitetura (25/nov): a pipeline CV foi extraída para o pacote `@wii/spatial-core` (`packages/core`) — protocolo em `packages/core/src/providers/poseProtocol.ts`, worker em `packages/core/src/providers/pose.worker.ts`. O pacote também já traz infraestrutura de **hand tracking** (`HandClient`, modelo hospedado) e replay gravado, hoje fora do caminho do app. Fusão pose+mão fica como trabalho futuro: o HandLandmarker foi desenhado para mãos em close, e a mão ocupa poucos pixels num enquadramento de corpo inteiro a ~2 m — ganho incerto, custo certo de inferência. O tênis desta iteração sai inteiro da pose, que é o caminho medido e conhecido.

1. **Evento `swing-start`** — novo tipo em `SportActionEvent`; `SwingDetector` emite no frame do onset.
2. **Enriquecimento do `swing` confirmado**: `contactY` (altura do punho no pico, larguras de ombro relativas ao ombro), `verticalSpeed` (vy no pico — proxy de spin), `onsetTimestampMs`.
3. **Câmera 60 fps**: `frameRate: { ideal: 60 }` sem teto — dobra amostras por swing onde o hardware permite.
4. **Fallback GPU→CPU por latência**: mediana dos tempos reais de inferência dos primeiros frames (descartando o primeiro, que carrega warmup); mediana > budget → recria em CPU e reporta `FALLBACK`. Fecha a armadilha medida no §7.5 da pesquisa (GL de software: 5-10 fps sem fallback). Medir em frames reais evita o problema de origem de relógio de probes sintéticos no init.

### Estratégia de testes

- TDD estrito nos quatro módulos puros: teste primeiro, determinístico, sem `setTimeout` — tempo é sempre parâmetro.
- Swing: fixtures sintéticas estendidas para onset/altura/vy — mesmas convenções de `tests/kinematics.test.ts`.
- Fallback GPU: função de decisão pura testada; integração verificada manualmente em `scripts/pose-bench.html`.
- `TennisGame` não é testado em Vitest (Three.js/WebGL) — toda a lógica de decisão vive nos módulos puros; a cena é integração verificada manualmente com teclado.

## 5. O que fica fora (YAGNI declarado)

- Service box / dupla falta / tie-break.
- Spin por torção de punho (impossível com o sensor).
- Modo fantoche contínuo (raquete do avatar dirigida pelo punho em tempo real) — futuro se a animação procedural não convencer.
- Multiplayer / duplas.
- Dificuldade adaptativa além da rampa linear.

## Como o Wii Sports faz, e o que adotamos

Consultado em [MiiWiki](https://miiwiki.org/wiki/Tennis) e
[Wikibooks](https://en.wikibooks.org/wiki/Wii_Sports/Tennis). São fontes de fãs.

| Wii Sports, segundo as fontes | Aqui |
| --- | --- |
| Movimento automático; o jogador só rebate | Igual |
| Tempo e altura da raquetada definem a direção | O tempo define o lado; onde o golpe termina define o arco |
| Saque: lança a bola e bate; no topo sai um saque rápido com rastro branco | Igual, mas o lançamento é automático |
| Baixo para alto faz lob; alto para baixo faz slice | Terminar bem acima da cabeça (altura prevista pela velocidade de subida): bola alta. Terminar abaixo do peito: rasante |
| Sempre em duplas | Simples |
| 1 game, melhor de 3 ou de 5; 15, 30, 40 e vantagem | Melhor de 3 |
| Torcida de Miis | Torcida simples |

**As fontes não falam de falta, dupla falta nem das regras de rede e fora.** Por decisão nossa, para o
jogo fluir: um golpe que acerta a bola sempre passa a rede, e o saque sempre entra.
