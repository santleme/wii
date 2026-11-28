# Plano do boxe: tracking, validação externa, jogo e tutorial

Data: 27 de novembro de 2026 · Base estudada: `origin/main` `94ffaaa`. Documento de planejamento, não implementação. Separa o que já existe no código, evidência medida, pesquisa externa e decisão proposta.

---

## 0. Status de implementação (27/11/2026, branch `research/boxing-tracking-plan`)

Implementado e com testes verdes (`npm test && npm run lint && npm run build`):

- **Replay parametrizável por fps** (`f4bef05`): `pose-replay.html?fps=15` amostra no ritmo do clipe — pré-requisito da avaliação UTD.
- **Medição e classificação de trajetória** (`e39196d`): `PunchMeasurement` (amostras corpo-locais em larguras de ombro, contato, pico de velocidade, deslocamentos) sai no evento `punch` confirmado; `punchClassifier.ts` puro classifica `straight/hook/uppercut/unknown` e alvo `head/body/unknown`; `PunchDetector.diagnostics` conta motivos de falha (onsets, confirmações, extensão/travel perdidos) e `ActionPipeline.punchDiagnostics` agrega por mão.
- **Socos tipados, defesa de duck e ataques tipados do oponente** (`37f7055`): `DuckTracker` em espaço de imagem (world landmarks são centrados no quadril e não servem); matriz de defesa `isDodgedTyped` — direto na cabeça: slip/duck; direto no corpo: só recuo/guarda; gancho: duck; uppercut: slip, duck nunca ajuda. Regras de dano do jogador: uppercut +25% em abertura, gancho penetra metade da guarda, soco no corpo faz 75% de dano mas ignora a guarda alta. Oponente sorteia mão, tipo e alvo em ordem fixa de rng.
- **Tutorial adaptativo** (`580f67c`): `BoxingTutorial` puro (guarda 1 s → 3 jabs → 3 cruzados → 2 ganchos → 2 uppercuts → 2 no corpo → 2 slips → 2 ducks), aprende mão da frente e alcance mediano por tipo na memória; modo `tutorial` no jogo com oponente passivo, hint após 10 s, desiste da etapa após 22 s, gesto de mãos erguidas pula.

Pendente, nesta ordem: validação de tipo e alvo com gravações roteirizadas, e validação com pessoas reais.

**Revisão da estratégia de validação externa (27/11/2026):** o BoxingVI não responde a pergunta de tipo para o nosso domínio. Os clipes são broadcasts de lutas filmados de lado — o soco viaja perpendicular ao eixo da câmera, então o canal de profundidade que a nossa medição usa simplesmente não existe nesses vídeos — e as anotações de pose são AlphaPose 2D em espaço de imagem, incompatíveis com a trajetória corpo-local em larguras de ombro que o classificador consome. O dataset olímpico do Zenodo sofre do mesmo problema (GoPro à beira do ringue, atletas pequenos no frame, dois lutadores se ocluindo). A pergunta "o classificador acerta jab/cross/hook/uppercut e cabeça/corpo numa webcam frontal?" só pode ser respondida com gravações frontais de golpes conhecidos — exatamente a infraestrutura de roteiro que o projeto já tinha para o tênis. Implementado: `BOXING_RECORDING_SCRIPT` (guarda → 3 jabs → 3 cruzados → 2 ganchos → 2 uppercuts → 2 no corpo → slips → ducks → 2 controles negativos), tecla G no modo boxe grava roteirizado com prefixo `boxe-`, e `tests/recordedBoxing.test.ts` julga tipo/alvo por janela com os mesmos tempos do roteiro. Falta uma pessoa real executar o roteiro uma vez para calibrar o floor.

**Estudo profundo com a primeira gravação real (28/11/2026):** a primeira gravação roteirizada (11,3 fps, delegate CPU — a condição real de produção, pior que os 15 fps do UTD) revelou três mecanismos com evidência direta:

1. **Agachar fabrica uppercuts fantasmas.** O referencial do soco é relativo ao ombro; na queda do duck os ombros descem ~0,25 unidades normalizadas e o punho parado no mundo "sobe" 1,0-1,6 larguras no referencial — trajetória idêntica a um uppercut, com extensão de cotovelo real (o braço estica de verdade quando o ombro desce e o punho fica). O sinal local do braço é indistinguível de um soco; o único discriminante é o movimento do referencial. Implementado: veto de onset enquanto a linha do ombro desce rápido (`REFERENCE_VETO_SPEED_SW_PER_S` = 0,7 sw/s, descida apenas). Custo documentado: o floor UTD cai de 23 para 22 clipes — soco atlético com queda de tronco é genuinamente ambíguo (s1t4 desce a 2,1 sw/s) — e o ganho de gameplay (defesa não vira ataque fantasma) supera o clipe. **Resíduo conhecido**: um onset que dispara na rampa da descida antes da velocidade medida cruzar o limiar escapa (o filtro atrasa ~1 frame); um phantom por gravação é o teto atual, codificado no floor.

2. **A forma do soco não pode ser medida na janela errada nem no referencial errado.** Duas corrupções independentes: (a) a janela de confirmação (walk-back + graça) inclui movimento que não é o soco — retração infla `pathLength` e dilui shares, cotovelo estendido de combinações anteriores contamina a origem; (b) o referencial do ombro **gira com o tronco** — um cruzado com rotação correta de quadril varre 1,5-2,0 larguras de lateral no referencial sem nenhum arco real no mundo. Implementado: posições do punho projetadas na base corporal **congelada no onset** (`frozen` nas amostras) e o classificador mede a forma numa janela auto-delimitada — do contato (máximo forward no frame congelado) para trás enquanto o forward sobe sem interrupção e nunca atravessando cotovelo já estendido (soco parte de câmara dobrada). Resultado na gravação real: o jab classifica `straight/head` correto; testes âncora cobrem retração e ruído de câmara. Descoberta adicional: a 11 fps o onset dispara no pico físico da extensão, então a forma vive quase toda *antes* do onset — a janela onset→contato é degenerada em produção.

3. **Recall de confirmação a 11 fps segue o gargalo dominante** (`missingExtension` 24 vs `missingTravel` 13 na gravação): a extensão física breve mal aparece na reconstrução a 11 fps. Reduzir o piso de deslocamento para 0,15 quase não recupera nada e admite falso positivo na guarda — evidência de que o gargalo é extensão, não deslocamento. O bent-stop da caminhada da origem é geometricamente correto mas foi revertido: a confirmação a 11 fps atualmente depende da caminhada cheia — dívida técnica registrada, a ser tratada junto com o trabalho de recall.

**Recall de confirmação resolvido com evidência (28/11/2026):** a instrumentação das janelas falhas revelou que a extensão de cotovelo estava *estruturalmente corrompida* na geometria de produção. Socar em direção à câmera é o pior caso da reconstrução monocular — o braço encurta ao longo do eixo óptico e o ruído de profundidade colapsa o ângulo reconstruído: na gravação real a 11 fps o cosseno bruto dos jabs verdadeiros pica em 0,2-0,37 e **nunca** atinge 0,65 em nenhum frame. O limiar geométrico media o que o braço *é*, não o que ele *mede*. O varrido de limiar contra os três floors mostrou: contagem de falsos positivos **idêntica** em 0,65, 0,2 e sem exigência alguma (a precisão é guardada por velocidade de onset + deslocamento + fechamento por retração), UTD 22→24 clipes, recall da gravação real 7→15 socos. Abaixo de 0,2 só entra phantom de duck — 0,2 é o ponto adotado, com a evidência no código. Descoberta complementar: onsets espelhados nas duas mãos durante socos de uma mão só (rotação de tronco contamina os dois canais) e onsets em slips — nenhum confirma, o que valida a cadeia a jusante.

Pendente, nesta ordem: resíduo do phantom de duck (veto retroativo ou adjudicação), validação cruzada com mais corpos, O bent-stop da caminhada da origem foi **testado e rejeitado com a barra de extensão corrigida**: elimina o phantom residual de duck (origens honestas não inflam o deslocamento do fantasma) mas custa 2 clipes UTD e 1-2 socos reais — e o classificador auto-delimitado já protege a forma independentemente da origem. Recall é a qualidade dominante em produção; a troca não se justifica.

**Adaptação do tutorial ligada ao detector (27/11/2026):** o perfil aprendido no tutorial não era consumido por nada — agora segue o padrão do tênis. O modo tutorial entra com o piso generoso de confirmação (`LEARNING_PUNCH_TRAVEL` = 0,15 larguras, para socos compactos de aprendizes confirmarem) e, ao concluir, informa ao pipeline o deslocamento adaptado: três quartos da mediana do alcance demonstrado, preso entre 0,15 e o padrão 0,25 — a adaptação só afrouxa, nunca aperta além do padrão. O valor persiste no pipeline quando o jogador sai para a luta, e volta ao padrão ao trocar de esporte. Coberto por testes em `boxingTutorial.test.ts` (matemática), `punchDetector.test.ts` (soco compacto confirma só com o piso adaptado) e `boxingGame.test.ts` (fio completo jogo→pipeline).

**Baseline formal UTD-MHAD (27/11/2026, pipeline instrumentada, 32 clipes a13 a 15 fps):** 13/32 clipes confirmam ≥1 soco no interior; 3/8 sujeitos atingem ≥3/4 — abaixo do critério de sucesso (6/8). Os contadores mostram 67 onsets para 15 confirmações, com causas dominantes `missingExtension` 43 e `missingTravel` 35 (e `timedOut` 11), contra **zero** `sampleGaps` e zero `invalidSamples`. Leitura: o rastreamento de pose não é o problema; os socos começam mas não alcançam a extensão de cotovelo (cos ≥ 0,65) ou o deslocamento (≥ 0,25 larguras de ombro) dentro de 350 ms — coerente com socos de shadow boxing frontais, compactos e sem oponente. O próximo passo é revisar a cadeia de confirmação com essa evidência (janela de tempo, exigência de extensão completa, ou ambos), sem afrouxar a ponto de aceitar gestos que não são soco. Observação secundária: parte dos confirmados classifica como `uppercut` em ação rotulada de golpes frontais — a validação de tipo no BoxingVI dirá se é viés do classificador ou do repertório dos sujeitos.

**Robustecimento da cadeia de confirmação (27/11/2026, mesma branch):** três correções de medição — nenhum limiar afrouxado — guiadas pelos contadores e pela análise quadro a quadro:

1. **Origem do curso.** O onset dispara quando o punho já está rápido (≥ 1,5 larguras/s), então boa parte do curso acontecia antes da origem da medição: medido do movimento todo, o punho avança 0,4–1,35 larguras; medido do onset, só 0,12–0,3. O detector agora caminha para trás na série filtrada (até 300 ms) procurando onde o movimento frontal começou.
2. **Janela fechando antes do pico.** A extensão máxima coincide fisicamente com o início da retração, e os filtros OneEuro atrasam 1–2 quadros — a janela fechava no primeiro frame de retração, antes do cosseno filtrado mostrar o pico. Socos não confirmados ganham graça de 120 ms de retração; confirmados continuam fechando na hora.
3. **Extensão avaliada no pico bruto.** O cosseno filtrado atenua picos breves em 0,03–0,1; a avaliação no fechamento usa o máximo entre filtrado e bruto sobre a janela (o ruído de um frame isolado não basta: onset, curso e timing continuam exigidos).

Resultado no floor offline permanente (`tests/utdMhadBoxing.test.ts`, gravações gitignored): **23/32 clipes, 6/8 sujeitos em ≥3/4 — critério pré-registrado de sucesso atingido** (era 13/32 e 3/8). Sujeito 5 tem reconstrução geometricamente impossível (o punho ganha meio metro de profundidade num quadro) e o sujeito 2 é marginal (1/4). Controle negativo (`tests/utdMhadNegatives.test.ts`, 56 clipes de 7 ações não-boxe dos mesmos sujeitos): **zero socos falsos em 6 ações**; só jumping jacks (a27) produziu 2 leituras em 1 clipe — precisão limpa. Observação residual: `missingTravel` continua relevante porque a reconstrução de profundidade do MediaPipe é mais ruidosa exatamente quando o braço aponta para a câmera — o canal z é o elo fraco da medição de socos frontais.

**Inspeção visual dos clipes (frames extraídos):** os sujeitos estão longe da câmera (corpo inteiro no frame, figura pequena) e socam de braços pendurados, sem guarda. Os sujeitos marginais 2 e 5 fazem socos genuinamente compactos, com o braço pouco estendido — o residual de detecção neles é dado ruim + movimento fraco, não lógica do detector. Advertência importante para o classificador de tipo: como o soco parte de braço pendurado, a subida da guarda contamina o `verticalRise` medido do início do movimento, e 15/29 confirmados classificam como `uppercut` em ação de golpes frontais — viés de medição nesse dev set, não necessariamente no jogo, onde o tutorial ensina guarda alta antes de socar. **A validação de tipo exige o BoxingVI, como previsto; UTD não responde essa pergunta.**


---

## 1. Resumo executivo

O boxe já existe na `main`: há detector de soco, guarda, esquiva lateral, aproximação/afastamento, dash, treino de saco, treino de esquiva e luta em primeira pessoa. O problema agora não é “criar boxe do zero”; é tornar o boxe **corporalmente legível e validado**:

1. **Endurecer a medição antes de classificar.** Uma avaliação exploratória no UTD-MHAD encontrou pose rastreada em ~96% dos quadros, mas só 14/32 clipes de `front boxing` confirmaram ao menos um soco. Houve 64 `punch-start` contra 15 `punch` confirmados. O gargalo é a cadeia de confirmação, não a presença da pose.
2. **Separar detecção de classificação.** O `PunchDetector` deve continuar respondendo rápido “houve soco?”. Um classificador puro deve consumir a trajetória medida e responder “jab/cross/hook/uppercut?” e “cabeça/corpo?”.
3. **Usar datasets para validar, não para retunar até passar.** UTD-MHAD é o primeiro teste porque é frontal e parecido com uma webcam; BoxingVI é o melhor conjunto específico para tipos de soco; o dataset olímpico de Szczyrk/Zenodo é o melhor para alvo cabeça/corpo/bloco/erro; gravações próprias com outras pessoas continuam insubstituíveis.
4. **Copiar o padrão do tênis:** jogo de timing e adjudicação retroativa, tutorial puro que aprende a pessoa, ajuda generosa quando o movimento compacto não é reconhecido.
5. **Tutorial adaptativo é parte do tracking.** Ele não é só instrução: é a fase que mede guarda, mão da frente, tamanho do soco, altura de alvo e amplitude de esquiva daquela pessoa.

---

## 2. O que atletismo e tênis ensinam

### 2.1 Pipeline comum

```
webcam
  -> PoseClient/pose.worker (MediaPipe Pose Landmarker, CPU por padrão)
  -> PoseSnapshot com image landmarks + world landmarks
  -> AdaptiveCalibrator (escala, centro neutro, pulsos de referência)
  -> ActionPipeline
       -> eventos discretos (sprint, swing, punch-start, punch)
       -> controles contínuos (guard, dodgeZone, ringDepth, lateralDash)
  -> jogo
```

Decisões importantes já provadas no projeto:

- **Medir em larguras de ombro.** Cancela distância da câmera e permite comparar corpos diferentes.
- **Sinal discreto em duas fases.** `*-start` é precoce e não confirmado, serve para animação; o evento confirmado carrega o instante físico estimado do pico e serve para regras.
- **Adjudicação retroativa.** O tênis julga o contato no `peakTimestampMs`, não no instante em que a confirmação chega. O boxe já usa a mesma ideia com `openingAt` e histórico de zonas.
- **Módulos de regra puros.** `boxingRules.ts`, `opponentAi.ts` e `trainingRules.ts` não importam DOM nem Three.js. Isso deve continuar.
- **Calibração implícita.** O `AdaptiveCalibrator` aprende escala, centro neutro e posições de pulso durante o jogo, com evidência temporal e mistura lenta.
- **Tutorial puro e adaptativo.** `tennis/tutorial.ts` avança por movimento reconhecido, explica após ~10 s parado, desiste/avança após ~22 s, pode ser pulado, aprende mão da raquete e tamanho do golpe sem ficar mais rígido que o padrão.
- **Fallback generoso.** O tênis tem assistência para jogadores cujos movimentos compactos não passam no detector principal. Boxe precisa do mesmo princípio: um soco claro mas curto não pode simplesmente desaparecer.

### 2.2 A restrição mais importante do projeto

`docs/jogos-pelo-corpo.md` declara que os limites foram ajustados em gravações de **uma única pessoa**, numa sala/webcam, e que uma gravação nova chegou a derrubar a corrida para 42% de detecção. Essa é a falha central a evitar no boxe: não basta funcionar no corpo do desenvolvedor.

---

## 3. O que já existe no boxe da `main`

### 3.1 Sensing

`src/kinematics/punchDetector.ts`:

- um detector por mão;
- mede pulso em coordenadas locais do corpo, com `forward = -z`;
- onset exige velocidade para a frente e abertura do cotovelo;
- confirmação exige extensão e deslocamento frontal mínimos dentro de uma janela;
- potência vem da velocidade de pico;
- rearma por retração ou repouso;
- os próprios comentários dizem que os limiares são palpites afináveis testados apenas com poses sintéticas.

`src/kinematics/postureSignals.ts` e `boxingLocomotion.ts`:

- `DodgeZoneTracker`: inclinação lateral pequena em relação ao centro calibrado;
- `RingDepthTracker`: aproximação/afastamento pela escala aparente combinando largura de ombros e altura de torso;
- `LateralDashTracker`: salto lateral curto;
- guarda binária por pulsos altos, próximos do corpo e cotovelos dobrados.

Limitações estruturais atuais:

- o soco exige quadris além de ombros/cotovelo/pulso, embora `bodyBasis` saiba cair para a vertical gravitacional sem quadris;
- `ActionPipeline` só alimenta `PunchDetector` quando o gate está `tracked`; quadros `degraded` interrompem a continuidade;
- a guarda exige as duas mãos e o tronco inteiro;
- não existe classificação de tipo de soco, altura de alvo, mão da frente/traseira, nem esquiva para baixo (`duck`);
- não há tutorial/calibração específica de boxe.

### 3.2 Jogo

`src/games/boxing/` já contém:

- luta em primeira pessoa com HP, 3 rounds de 60 s, guarda, dano, contra-ataque e KO;
- oponente em ciclo puro guarda → windup → recover, com `openingAt` retroativo;
- treino de saco por ritmo e treino de esquiva por zonas;
- movimento de ringue por inclinação sustentada, profundidade e dash;
- seleção de modo/adversário e controles de teclado de desenvolvimento.

O jogo atual trata todo soco confirmado da mesma forma, modulando apenas `power01`, abertura e contra-ataque. A oportunidade do próximo desenho é fazer o **tipo** e o **alvo** importarem sem criar uma simulação complexa demais.

---

## 4. Medição exploratória em UTD-MHAD

### 4.1 Método

Avaliação exploratória, não um benchmark final e não critério para ajuste de limiar:

- ação `a13` (`front boxing`) do UTD-MHAD, 8 pessoas × 4 tentativas = 32 clipes;
- RGB 640×480, cabeçalho dos AVI a 15 fps; conversão temporária para WebM preservando resolução e número de quadros, nominalmente a 15 fps;
- Chromium headless 159, worker real, delegate CPU, Pose Landmarker Lite;
- `AdaptiveCalibrator` + `ActionPipeline` da `main`, com a banda de centro usada pelo modo boxe;
- critério de clipe detectado: pelo menos um `punch` confirmado no miolo do clipe (descontados 0,5 s no início e 0,25 s no fim);
- nenhum limiar foi alterado; nenhum clipe foi escolhido depois de olhar resultado.

Artefatos e mídia ficaram fora do Git em `/tmp`, seguindo a política de privacidade. SHA-256 do manifesto local dos AVI de `a13`: `d08eef993d3b51e790c0af87f0a3479e88f07a755fd164d136752188444515c5`.

### 4.2 Resultado

| Métrica | Resultado |
|---|---:|
| clipes processados | 32/32 |
| quadros com tracking `tracked` | média 96,1% |
| quadros com escala pronta | média 78,3% |
| clipes com ≥1 soco confirmado | 14/32 (43,8%) |
| pessoas com ≥3/4 tentativas detectadas | 3/8 |
| `punch-start` totais | 64 |
| `punch` confirmados totais | 15 |
| sujeito 2 | 0/4 tentativas detectadas |
| sujeito 5 | 0/4 tentativas detectadas |

Por pessoa, tentativas com pelo menos um soco confirmado:

| pessoa | tentativas detectadas |
|---:|---:|
| 1 | 1/4 |
| 2 | 0/4 |
| 3 | 3/4 |
| 4 | 2/4 |
| 5 | 0/4 |
| 6 | 2/4 |
| 7 | 3/4 |
| 8 | 3/4 |

### 4.3 Leitura

O detector vê o corpo quase sempre, mas começa muito mais socos do que confirma. A hipótese principal não deve ser “abaixar tudo”; deve ser medir onde a cadeia morre:

1. o onset dispara tarde, já perto do pico, por causa de 15 fps e filtragem;
2. o deslocamento frontal em `z` monocular é instável e às vezes não acumula o curso mínimo a partir da amostra anterior ao onset;
3. quadros `degraded` no meio da extensão fazem o pipeline pular amostras, e uma sequência curta de buracos reinicia o detector;
4. a retração/deceleração é detectada antes de uma amostra simultaneamente satisfazer extensão e curso;
5. pessoas diferentes fazem “front boxing” com amplitude e velocidade muito diferentes — exatamente o problema que o projeto já conhece.

`punch-start` também não é uma contagem limpa de socos candidatos: rearma/re-onset pode inflar o total dentro da mesma ação. Ainda assim, a assimetria é grande demais para ignorar. Como `a13` é rótulo de ação por clipe, não por soco, essa medição não estima precisão nem recall por soco. Também não mede falsos positivos. É evidência de fumaça: o tracking existe, mas ainda não é robusto entre corpos.

---

## 5. Datasets públicos e papel de cada um

### 5.1 Matriz de escolha

| Dataset | O que tem | Por que importa | Limites/licença | Papel proposto |
|---|---|---|---|---|
| [UTD-MHAD](https://personal.utdallas.edu/~kehtar/UTD-MHAD.html) | 8 pessoas, 4 repetições, RGB/depth/skeleton/IMU; ação 13 `front boxing`; frontal | Mais próximo do caso webcam frontal; já usado aqui para corrida | Página não declara licença padronizada; pessoas pequenas no quadro; só uma classe genérica de boxe | **Primeiro smoke test externo** de presença/robustez, não classificação fina |
| [BoxingVI](https://github.com/Bikudebug/BoxingVI) / [paper](https://arxiv.org/abs/2511.16524) | 6.915 clipes de soco, 20 vídeos YouTube, 18 atletas, 6 classes: cross, jab, lead/rear hook, lead/rear uppercut; limites temporais + pose 2D AlphaPose | Melhor correspondência para classificação de tipos em vídeo monocular real | Repositório sem licença declarada; download em Google Drive; vídeos de treino/instrução, não webcam doméstica; pose AlphaPose ≠ MediaPipe | **Benchmark principal de tipo de soco**, com split por sujeito |
| [Olympic Boxing Fight Video Dataset](https://doi.org/10.5281/zenodo.21295125) | 22 lutas, 4 GoPro 1080p50 sincronizadas, rostos borrados; classes cabeça/corpo/bloco/erro por mão, anotadas por especialistas | Melhor fonte para alvo cabeça/corpo e resultado bloqueado/errado | CC BY 4.0; lutas reais com oclusão e duas pessoas; participantes de categorias jovens, exige cuidado ético mesmo anonimizado | **Benchmark de alvo e defesa**, não primeira validação de webcam |
| [Smart Boxer IMU](https://doi.org/10.5281/zenodo.14965635) / [paper](https://pmc.ncbi.nlm.nih.gov/articles/PMC12061147/) | IMU de punho a 200 Hz de boxeadores elite, jab/hook/uppercut de mão lead/rear | Referência de dinâmica temporal e separabilidade dos tipos; CC BY 4.0 | Não é visão; eixos do sensor não são eixos da câmera; dados contínuos precisam segmentação | **Checagem de plausibilidade cinemática**, não entrada do jogo |
| Berkeley MHAD | 12 pessoas, ação `punching`, mocap + multi-view RGB/depth/acelerômetro | Ground truth 3D corporal e variação de estilo | Site oficial atualmente instável; licença BSD-2 reportada em catálogo secundário, precisa confirmar antes de uso/redistribuição | Referência 3D secundária |
| [MSR Action3D](https://sites.google.com/view/wanqingli/data-sets/msr-action3d) | `forward punch` e `side-boxing`, 10 sujeitos, depth + skeleton 20 joints | Duas formas de soco em dados controlados | Sem RGB natural completo no formato do nosso pipeline; licença não evidente | Baixa prioridade; comparador esquelético |
| [NTU RGB+D](https://rose1.ntu.edu.sg/dataset/actionRecognition/) | A50 `punch/slap`, 40 sujeitos, RGB+D+IR+3D joints, 3 câmeras | Escala e diversidade de corpos | Termos exigem projeto acadêmico institucional e e-mail institucional; ação é interação entre duas pessoas, não técnica de boxe | **Não usar neste projeto pessoal** |
| [UCF101](https://www.crcv.ucf.edu/research/data-sets/ucf101/) / [Kinetics](https://arxiv.org/abs/1705.06950) | classes `BoxingPunchingBag`, `BoxingSpeedBag`, `punching bag`, `punching person (boxing)` | Diversidade visual “in the wild” | Rótulos de clipe, sem demarcação/pose/limpeza suficiente; links YouTube e termos variáveis | Referência qualitativa/estresse, nunca critério de threshold |
| [BoxMAC](https://arxiv.org/abs/2412.18204) | 15 boxeadores profissionais, 13 rótulos incluindo socos, stance, slip, block, guard, duck, clinch; 60k frames/2.314 clipes | Cobertura rara de defesas | Artigo não deixa disponibilidade/licença igualmente claras; sem pose; cenário de luta | Fonte de inspiração taxonômica e possível benchmark futuro |

### 5.2 Consequência prática

Nenhum dataset sozinho responde a pergunta do produto: “uma pessoa comum, em frente a uma webcam de notebook, faz um movimento que nosso detector entende?”. Por isso a validação precisa ser em camadas:

1. **UTD-MHAD**: corpos diferentes em câmera frontal controlada.
2. **BoxingVI/Olympic**: variedade real de técnica e alvo.
3. **Gravações próprias com pelo menos 3 outras pessoas**: a única camada que representa distância, enquadramento, iluminação e comportamento do jogador no nosso jogo.

Critérios e análise devem ser definidos antes de olhar os resultados. Datasets não entram no repositório; apenas manifestos, hashes e métricas agregadas.

---

## 6. Evidência biomecânica útil para o design

A literatura não dá limiares diretos para nossa webcam, mas impede erros de concepção:

- Estudo 3D com 15 amadores encontrou diferenças significativas entre straight/hook/uppercut; o jab teve o menor tempo de entrega (~405 ms) e o lead hook a maior velocidade de punho (~11,95 m/s) ([Tandfonline, 2018](https://www.tandfonline.com/doi/full/10.1080/24748668.2018.1525651)).
- Estudo de jab/cross/hooks em boxeadores de competição também encontrou tempos menores em jab/cross que em hooks e velocidades de contato da ordem de vários m/s ([Sports Biomechanics, 2011](https://doi.org/10.1080/14763141.2010.547590)).
- Trabalho clássico com câmeras sincronizadas viu velocidades de contato de 5,9–8,2 m/s e diferenças cinemáticas entre hooks e jabs ([PubMed](https://pubmed.ncbi.nlm.nih.gov/3377096/)).
- O estudo Smart Boxer relata socos completos em média dentro de ~0,9 s e usa características tempo-frequência de IMU; jab/hook/uppercut separam por padrões de intensidade, curvatura e controle rotacional ([PLOS One, 2025](https://pmc.ncbi.nlm.nih.gov/articles/PMC12061147/)).
- Um estudo de defesas em boxeadores elite descreve slipping, ducking e sidesteps como movimentos de centro de massa/torso com amplitude, velocidade e simetria dependentes do nível do atleta ([BMC Sports Science, 2026](https://link.springer.com/article/10.1186/s13102-026-01693-x)).

Implicação para webcam a 15–30 fps: um jab pode ocupar só ~6–12 quadros; o pico pode acontecer entre quadros; motion blur é esperado. O design não pode depender de uma única amostra exata nem de `z` fino. Deve depender de **forma da trajetória**, confirmação com janelas generosas e timestamps de pico estimados.

---

## 7. Arquitetura de tracking proposta

### 7.1 Separar três perguntas

1. **Houve um soco?** — detector reativo, baixa latência, por mão.
2. **Que soco foi?** — classificador puro sobre a trajetória já medida.
3. **O corpo estava defendendo/esquivando?** — controles contínuos independentes, amostrados na janela física do golpe.

Isso evita o erro de transformar `PunchDetector` numa máquina enorme e preserva o canal `punch-start` para animação.

### 7.2 Medição que o detector deve preservar

Hoje o evento confirmado carrega apenas mão, potência e timestamps. Para classificar sem adivinhar depois, o detector deve reter amostras da trajetória do onset à confirmação/retração, em unidades de largura de ombro:

- posição local do pulso `(x, y, z)` relativa ao próprio ombro;
- cosseno/ângulo do cotovelo;
- tempo, velocidade e altura do pico;
- posição de origem, pico e fim;
- curso frontal, lateral e vertical;
- comprimento do caminho e razão deslocamento/caminho;
- rotação do tronco aproximada pela linha dos ombros, quando confiável;
- confiança e contagem de quadros perdidos.

O evento público não precisa expor toda a série crua se isso inflar o protocolo; pode expor um `PunchMeasurement` compacto. Os módulos de teste podem consumir a série interna.

### 7.3 Classificação de tipo

Classes iniciais, deliberadamente pequenas:

| Classe geométrica | Assinatura esperada | Uso no jogo |
|---|---|---|
| `straight` | dominância frontal, extensão alta do cotovelo, trajeto relativamente reto | jab/cross dependendo da mão em relação à stance |
| `hook` | grande componente lateral/curvatura horizontal, cotovelo menos estendido, rotação do tronco | golpe angular, pode contornar parte da guarda |
| `uppercut` | componente vertical de subida + extensão moderada, trajeto curvo de baixo para cima | punir duck/guarda baixa |
| `unknown` | evidência insuficiente | sempre deve existir; nunca fingir precisão |

`jab` e `cross` não são apenas geometria do braço: dependem de qual mão é a da frente na stance. O tutorial deve inferir/perguntar corporalmente a stance. Se a stance for incerta, o jogo pode usar `straight-lead`/`straight-rear` hipotéticos ou simplesmente `straight` sem forçar nome boxístico.

Regras de design:

- classificação é probabilística internamente, discreta externamente, com `confidence`;
- `unknown` é resultado legítimo e usa regra genérica de soco;
- nunca classificar por um único eixo; hooks/uppercuts compactos são ambíguos por natureza;
- a classe não pode atrasar o evento: ela é calculada no mesmo ponto de confirmação, usando só dados até aquele instante.

### 7.4 Alvo: cabeça ou corpo

O usuário pediu soco na cabeça e no peito/corpo. A maneira robusta não é tentar ler intenção fina, e sim duas zonas generosas:

- `head`: altura do punho no pico/contato próxima ou acima da linha dos ombros/queixo;
- `body`: altura claramente abaixo da linha dos ombros, na faixa peito/abdômen;
- `unknown`: zona intermediária ou tracking fraco.

A altura deve ser relativa ao torso calibrado, não à imagem crua. Inclinar o tronco para baixo não pode, sozinho, transformar todo soco em golpe de corpo; por isso a decisão usa posição do punho em coordenadas corporais e, se disponível, uma referência de guarda aprendida no tutorial.

### 7.5 Defesas

Hoje existem guarda e slip lateral. O plano mínimo completo é:

| Defesa | Sinal | Estado |
|---|---|---|
| guarda alta | pulsos perto de rosto/ombros, cotovelos dobrados | existe de forma binária |
| slip esquerdo/direito | deslocamento lateral pequeno do centro neutro | existe como `dodgeZone` |
| duck | queda vertical rápida e reversível de ombros/cabeça em relação ao neutro | **falta** |
| recuo | aumento de distância/aparente encolhimento do corpo | existe como `ringDepthMove`/`ringDepth01` |
| guarda baixa/corpo | pulsos protegendo torso, não rosto | **opcional, depois de medir** |

`duck` merece um tracker puro próprio, com histerese e proteção contra confundir agachamento lento de reposicionamento com defesa. Como no soco, deve haver onset precoce para animação e estado confirmado/contínuo para regras.

Parry/perry manual fica fora do escopo inicial: um movimento de mão curto lateralmente é muito fácil de confundir com hook, guarda imperfeita ou ajuste de postura numa webcam frontal.

### 7.6 Robustez temporal

Mudanças de pipeline a testar antes de classificar:

1. **Não descartar o soco por um quadro borrado.** Assim como o `SwingDetector`, um buraco curto deve ser pulado; buracos longos reiniciam.
2. **Separar gates.** O soco não precisa necessariamente dos mesmos quadris que footwork. Se `bodyBasis` tem fallback sem quadris, medir se isso é suficiente para braço; footwork continua exigindo torso inteiro.
3. **Instrumentar motivo de não confirmação.** Contadores puros: onset sem extensão, extensão sem curso, timeout, gap de amostra, confiança baixa, retração antes de confirmar.
4. **Medir 15 e 30 fps separadamente.** UTD é 15 fps; webcam pode ser 30/60. Nada de escolher threshold que só existe porque há mais amostras.
5. **Benchmark de latência.** `pose-bench.html` antes/depois; classificação não pode custar latência perceptível porque usa dados já existentes.

---

## 8. Gameplay proposto

### 8.1 Princípio arcade

Como no tênis, o jogo deve ser **legível, não uma simulação fiel**. O jogador precisa entender por que ganhou ou perdeu cada troca.

Regras centrais propostas:

- todo soco confirmado causa algum efeito se estiver ao alcance e na janela;
- classe e alvo modificam risco/recompensa, não criam golpes impossíveis;
- guarda reduz dano, não anula tudo para sempre;
- esquivar na direção certa abre contra-ataque;
- erro de classificação degrada para regra genérica, nunca parece injusto.

### 8.2 Tabela inicial de consequências

Uma proposta pequena o bastante para testar:

| Golpe reconhecido | Vantagem | Custo/risco |
|---|---|---|
| jab/straight lead | rápido, boa chance de interromper windup, pouco comprometimento | dano baixo |
| cross/straight rear | dano médio/alto, mais alcance | recuperação maior; punível se lento |
| hook | bônus contra guarda frontal ou quando o alvo está alinhado ao lado | whiff deixa abertura maior |
| uppercut | bônus contra duck ou guarda baixa | exige proximidade; ruim contra recuo |
| golpe no corpo | dano menor de HP, mas reduz stamina/guarda ou aumenta lentidão de recuperação | menos decisivo que cabeça |
| golpe na cabeça | dano maior | mais fácil de defender com slip/guarda alta |

Ainda há uma decisão de design pendente: stamina ou não. A recomendação KISS é **não criar stamina na primeira iteração**. Em vez disso, socos no corpo aplicam um debuff curto e visível de recuperação/guarda do oponente; se isso parecer arbitrário, só então considerar stamina como recurso explícito.

### 8.3 Oponente

Oponente deve deixar de ser apenas `hand + targetZone` e passar a ter um ataque tipado:

```
hand: left/right
kind: straight/hook/uppercut
target: head/body
lane: -1/0/1
impactAtMs
```

A defesa correta depende do tipo, mas com poucas regras memoráveis:

- straight alto: slip ou guarda alta;
- hook: duck/recuo ou guarda no lado correto;
- uppercut: não duck; recuo/guarda alta;
- golpe no corpo: recuo ou guarda baixa, se guarda baixa entrar; caso contrário step/back.

O telegraph visual precisa ser honesto: o oponente mostra ombro/quadril/luva de forma distinguível antes do impacto. Como no design do tênis, o tempo de reação deve partir do evento físico, e a janela de defesa deve usar amostras corporais no intervalo `[impact, impact + grace]`.

### 8.4 Treino e modos

- **Saco de pancadas:** ideal para ensinar tipos e alvos. O saco/mitt pode pedir “jab alto”, “cross no corpo”, “hook” em sequência, com pontuação por tipo reconhecido e timing.
- **Treino de esquiva:** evoluir de zonas laterais para ataques tipados, mas manter a mesma máquina pura de telegraph/active/resolved.
- **Luta:** entra só depois que o jogador passa por uma versão curta do tutorial, ou pula explicitamente.

---

## 9. Tutorial adaptativo de boxe

### 9.1 Princípios copiados do tênis

- uma instrução por vez;
- sem adversário ativo enquanto aprende;
- critérios mais generosos no início;
- dica depois de ~10 s sem progresso;
- avança/desiste depois de ~22 s, sem prender a pessoa;
- gesto das duas mãos para pular;
- aprende sem ficar mais rígido que os padrões;
- toda regra do tutorial em classe pura testável, como `TennisTutorial`.

### 9.2 Sequência proposta

1. **Enquadramento de boxe.** Cabeça, ombros, quadris e pulsos visíveis quando possível; distância suficiente para socos não saírem do quadro. Se os quadris não forem necessários para soco após a separação de gates, a instrução muda para o enquadramento real exigido.
2. **Guarda.** “Levante os dois punhos perto do rosto”. Segurar ~1 s. Aprende posição de guarda de cada mão e estima stance.
3. **Jab da frente.** Três repetições. O jogo mostra a mão esperada apenas depois de inferir a stance; se incerto, aceita qualquer straight primeiro e depois nomeia.
4. **Cross/straight da traseira.** Três repetições. Aprende curso frontal, velocidade e extensão por mão.
5. **Hook.** Duas repetições por mão ou pelo menos uma lead hook. Aceita movimento amplo no começo; depois mede curvatura compacta.
6. **Uppercut/corpo.** Duas repetições de subida; depois alvo baixo num pad visual.
7. **Alvo alto/baixo.** Mittens ou zonas no oponente/saco pedem cabeça/corpo. Aprende o mapeamento vertical daquela pessoa.
8. **Slip.** Esquerda/direita, com retorno ao centro. Aprende amplitude confortável sem exigir deslocamento exagerado.
9. **Duck/recuo.** Uma repetição cada; se não reconhecer, mantém slip+guarda como defesas suficientes.
10. **Mini-combinação.** jab → cross → hook ou jab → corpo → cabeça, sem pressão; depois luta curta de teste.

### 9.3 O que o tutorial aprende

| Perfil aprendido | Como usa depois |
|---|---|
| mão da frente/stance | nomear jab/cross e telegrafar instruções corretas |
| posição de guarda por mão | reduzir falsos negativos de guarda e distinguir alta/baixa |
| curso e velocidade típicos por tipo | aceitar socos compactos sem abrir para ruído |
| altura de alvo alto/baixo | separar cabeça/corpo naquela pessoa/câmera |
| amplitude de slip/duck | adaptar zonas sem deixar ruído virar esquiva |
| taxa de perda/qualidade da pose | escolher feedback e assistência apropriados |

O perfil deve viver em memória na sessão, como a mão da raquete do tênis. Persistir dados corporais no navegador exige decisão explícita de privacidade e não é necessário para a primeira versão.

### 9.4 Feedback corretivo

O tutorial deve dizer o que mudar, não só “não reconhecido”:

- “estenda mais o braço para a frente” quando extensão insuficiente;
- “comece com o punho na guarda” quando a origem está errada;
- “faça o hook mais para o lado” quando lateralidade insuficiente;
- “suba o punho no final” para uppercut;
- “mire mais alto/mais baixo” para alvo;
- “mostre o braço inteiro” quando confiança/oclusão domina.

Esses diagnósticos dependem dos contadores de motivo de falha da seção 7.6 — mais uma razão para instrumentar antes de classificar.

---

## 10. Plano de validação

### 10.1 Infraestrutura necessária

Primeiro trabalho de engenharia, independentemente de regra de jogo:

1. tornar `pose-replay` parametrizável por fps (o UTD é 15 fps, não 30);
2. permitir execução batch/headless que exponha a gravação e métricas, sem redistribuir vídeo;
3. salvar manifestos com SHA-256 de clipes, conversões, modelo, commit e configuração;
4. adicionar contadores de motivo de não confirmação do soco;
5. registrar métricas por sujeito, não só médias globais.

Essas mudanças devem ser PRs pequenos e independentes.

### 10.2 Protocolo UTD-MHAD

Pré-registrar antes do próximo ajuste:

- positivos: `a13 front boxing` (32 clipes);
- negativos: caminhada, jogging, squat e ações de braço já usadas na avaliação de corrida, mais ações confundíveis (`throw`, `baseball swing`, `tennis forehand`, `tennis serve`, `two-hand push`, `knock`, `catch`, `pick up and throw`) se extraídas;
- critério de clipe positivo: ≥1 soco confirmado no miolo;
- critério por pessoa: ≥3/4 tentativas;
- critério inicial de sucesso proposto: ≥6/8 pessoas, sem falsos positivos materiais nos negativos;
- reportar `punch-start`, confirmações, potência, tracking, scale readiness e motivos de falha.

Como não há rótulos por soco, esse teste mede sensibilidade mínima por clipe, não contagem exata.

### 10.3 Protocolo BoxingVI

- usar train/validation por sujeito como publicado, ou criar split próprio por atleta se os vídeos/agrupamentos exigirem;
- passar RGB pelo mesmo worker MediaPipe; não usar AlphaPose como entrada, apenas como referência comparativa;
- métricas: recall temporal por overlap/tolerância, precisão de eventos, matriz de confusão por tipo, latência onset→confirmação;
- não ajustar no validation; ajustar apenas em train/dev e reportar validação uma vez.

### 10.4 Protocolo Olympic/Zenodo

- usar apenas trechos revisados/anotados, respeitando a lista de frames revisados;
- métricas separadas para alvo head/body/block/miss;
- medir se nosso alvo geométrico concorda com a categoria do árbitro, sem esperar correspondência perfeita: um soco ao corpo na anotação pode ter punho final alto por causa de postura/alcance;
- manter vídeos fora do Git e citar CC BY 4.0 em qualquer figura ou uso público.

### 10.5 Gravações próprias com outras pessoas

Critério mínimo antes de chamar o boxe de robusto:

- pelo menos 3 pessoas além do desenvolvedor;
- consentimento explícito; arquivos em `tests/recordings/`, gitignored;
- roteiro guiado curto: guarda, jab, cross, hooks, uppercuts, alto/baixo, slips, duck, recuo, movimentos neutros;
- critérios pré-definidos por pessoa e por movimento;
- reportar separadamente pessoas compactas/rápidas, canhotos e quem nunca boxeou.

---

## 11. Sequência de implementação recomendada

1. **Instrumentação e replay batchável.** Pequeno, independente, sem mudar comportamento do jogo.
2. **Baseline formal UTD.** Repetir a medição com relatório completo e motivos de falha.
3. **Robustez do detector genérico.** Corrigir gaps/degraded/hips/contagem de falhas, com testes sintéticos e replay; só depois mexer em limiares se a evidência disser isso.
4. **`PunchMeasurement` + classificador puro.** Sem mudar regras do jogo ainda; validar em fixtures sintéticas e BoxingVI dev.
5. **Alvo cabeça/corpo.** Validar contra Olympic e gravações próprias; manter `unknown`.
6. **Tutorial adaptativo.** Em paralelo ao classificador, porque ele produz o perfil necessário para nomes e thresholds pessoais.
7. **Gameplay tipado.** Oponente, regras de tipo/alvo, treino de saco e esquiva tipados.
8. **Validação com pessoas reais.** Só então ajustar defaults finais.

A ordem evita o caminho tentador e errado: inventar interações de jogo em cima de um detector que ainda não confirma socos de outras pessoas.

---

## 12. O que fica fora (YAGNI declarado)

- parry/perry manual na primeira versão;
- stamina como barra completa na primeira versão;
- estimativa fina de força real em Newtons;
- classificação de estilo ortodoxo/southpaw além do necessário para mão da frente;
- uso de HandLandmarker para punho/dedos — mãos ocupam poucos pixels em corpo inteiro e o ganho é incerto;
- treino de modelo ML pesado dentro do navegador;
- persistência de dados corporais sem decisão explícita de privacidade;
- redistribuição de vídeos de datasets no repositório.

---

## 13. Decisões abertas para revisão

1. **Manter boxing body-only ou aceitar teclado como modo dev explícito?** Hoje o HUD expõe teclado. Recomendação: corpo como experiência principal; teclado apenas com flag/dev, como ferramenta de teste.
2. **Nomear jab/cross sem stance confiável?** Recomendação: só nomear depois do tutorial inferir; caso contrário usar straight genérico.
3. **Guarda baixa entra já?** Recomendação: não antes da validação de alvo; guarda alta + recuo bastam para golpes de corpo na primeira iteração.
4. **Usar BoxingVI sem licença explícita?** Pode ser usado para avaliação interna se o download for acessível, mas nada de redistribuir; pedir/licenciar ou preferir Zenodo CC BY para artefatos públicos.
5. **Quando endurecer `PunchDetector`?** Somente depois dos contadores de falha mostrarem a causa; não usar a taxa 14/32 como desculpa para ajuste cego.
