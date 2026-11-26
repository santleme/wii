# Pesquisa — tracking robusto: como produção evita perda espúria de pose em jogos/fitness com câmera

Data: 26 de novembro de 2026 · Branch: `main` (`4ffa382`)

Pesquisa contra **fontes primárias**: o white paper oficial de suavização do Kinect (Microsoft Learn archive), as Human Interface Guidelines do Kinect for Windows v1.7 (PDF oficial Microsoft), o blog de engenharia do Meta Quest *First Steps* (algoritmo de filtragem de hand tracking em produção), a apresentação do VP de CV da Peloton (Embedded Vision Summit), o blog de engenharia do Just Dance Camera Controller (Ubisoft), o model card oficial do BlazePose GHUM 3D (PDF Google embutido no Hugging Face), o paper do BlazePose (arXiv 2006.10204), o paper do DeepSORT (arXiv 1703.07402), o paper do 1€ Filter (Casiez et al., CHI 2012), o código-fonte `tensorflow/tfjs-models` (pose-detection/MoveNet) e `google-ai-edge/mediapipe` (filtros C++), issues do repo oficial do MediaPipe, a spec W3C Image Capture e literatura de tracking de câmera. Complementa `docs/autocalibracao-tolerancia-perda.md` (semântica interna de `visibility`/`presence` e do grafo), `docs/auditoria-mediapipe.md` (suavização interna) e `docs/pesquisa-robustez-gestos.md` (jitter e re-arming de detectores) — aqui o foco é **o que produtos que shiparam fazem entre o frame ruim e a decisão de gameplay**.

**Problema motivador**: hoje o `TrackingGate` declara `lost` após 4 frames ruins consecutivos (~133 ms a 30 fps — `src/kinematics/trackingGate.ts:34`), o label vira `SEM POSE` (`src/App.tsx:131`) e o `RunGate` pausa a corrida e, na volta, reinicia com countdown de 3 s (`src/games/track/runGate.ts:31-33,51-54`). Uma rajada de oclusão/motion-blur de ~130 ms — invisível para o jogador — custa uma pausa + 3 s de contagem. A pergunta: o que a indústria faz nesse intervalo?

---

## 1. Resumo executivo

1. **Nenhum produto de referência reage a perda de tracking em ~130 ms.** Os números concretos encontrados em produção convergem para uma janela de graça de **centenas de ms a 1 s**: Meta First Steps só derruba objeto após 75 ms contínuos de baixa confiança + espera 15 ms de estabilização pós-recuperação; DeepSORT (o tracker de referência da literatura) deleta uma track só após `max_age = 30` frames sem match (~1 s a 30 fps) e exige 3 detecções consecutivas para criar track; o tracker do próprio tf.js pose-detection do Google usa `maxAge: 1000` ms; um retargeting VRM com MediaPipe publicado usa 0,5 s antes de soltar o avatar para neutro. O Kinect HIG prescreve explicitamente que o usuário primário **não** seja desengajado imediatamente.
2. **O padrão de dropout não é "pausar": é coast com amortecimento + interpolação de retorno.** O algoritmo documentado do Meta First Steps (produto flagship de onboarding VR): extrapola posição por velocidade/angular-velocity do último dado de alta qualidade, aplica damping por frame ruim para desacelerar até parar, e ao recuperar interpola do extrapolado para o real em **~100 ms** (10 frames) mirando sempre o dado mais recente — nunca há "snap" nem pausa. Peloton trata oclusão/iluminação/enquadramento por **nudging de UI, sem introduzir fricção** ("ML and UI work together … without introducing friction").
3. **Lite é provavelmente uma falsa economia para este jogo.** Na avaliação oficial do próprio Google em Yoga/Dance/HIIT (os datasets mais próximos do nosso uso), o Full ganha do Lite por **+5,3/+3,8/+2,2 pontos de PCK@0,2** custando apenas **+5 ms/frame no GPU de um Pixel 3 de 2018 (25 vs 20 ms)** e +2 ms num MacBook Pro 2017 (27 vs 25 ms). No model card GHUM 3D a diferença é 87,0% → 91,8% PDJ (+4,8). Heavy custa o dobro do Full (53 ms) por +2 a +3 pontos adicionais — esse sim provavelmente não compensa. O modelo Lite tem pior comportamento justamente nos extremos de skin tone/região (ranges 6,5–7,3 vs 4,8–5,7 do Heavy).
4. **O gate por `min(visibility)` dos pontos centrais é mais estrito que qualquer prática publicada.** O autor do BlazePose recomenda threshold **0,5** pós-sigmoid por ponto; a literatura de aplicações usa 0,5–0,7 **por landmark envolvido no cálculo**, nunca "o mínimo de um conjunto derruba o corpo inteiro". E a prescrição sistemática (Microsoft, Google, Meta) é: ponto ruim → segura último valor bom / não computa o sinal derivado naquele frame — não zera o jogo.
5. **O fast-motion é um modo de falha conhecido e ainda aberto do Pose Landmarker** (issue #6239: landmarks "carried away"/destacados em movimentos explosivos, pior em FPS baixo, sem solução do maintainer). Câmera a 60 fps reduz deslocamento inter-frame e limita o tempo de exposição máximo (1/60 s), reduzindo motion blur — a constraint `frameRate: {ideal: 60}` já presente está na direção certa e há evidência para mantê-la.
6. **Duas fontes de erro distintas exigem dois tratamentos distintos** (white paper Kinect §2): ruído branco pequeno e constante → filtro de suavização; spikes temporários durante inferência/oclusão → filtro de spike/outlier + suavização adaptativa mais agressiva *só quando o ponto está inferido*. Um filtro único não resolve os dois.

---

## 2. O que exergames e apps de fitness em produção fazem durante oclusão/saída de frame

### 2.1 Meta First Steps (VR, hand tracking — o caso mais bem documentado)

O time do Meta Quest documentou o algoritmo completo de mitigação usado no *First Steps*, app flagship de onboarding, porque "a acurácia de posição/orientação da mão degradava rápido em certas condições (iluminação pobre, oclusão mão-sobre-mão) e era extremamente danoso ao gameplay" — [developers.meta.com/vr/blog/adding-hand-tracking-to-first-steps](https://developers.meta.com/vr/blog/adding-hand-tracking-to-first-steps/):

**Pipeline de 5 passos por frame:**
1. **Stillness freezing** — se o dado não mudou perceptivelmente desde o frame anterior, mantém o transform anterior (elimina micro-jitter sem custo).
2. **Jitter smoothing** — se o novo dado está perto do anterior, interpola em direção a ele por uma porcentagem pequena (lag só em movimentos pequenos, onde não é perceptível).
3. **Classificação de qualidade** — inválido → low quality; confiança alta → high quality; senão heurísticas.
4. **Extrapolação (coast)** — *não* interpolam em direção ao dado de baixa qualidade ("isso acabou sendo ainda mais frustrante que o dado incorreto"). Em vez disso: **integram velocidade e velocidade angular do último dado high-quality**, e cada frame de baixa qualidade aplica um **escalar de damping** às velocidades, fazendo as mãos desacelerarem até parar se a rajada persistir.
5. **Interpolação de retorno** — ao voltar dado high-quality, interpola do extrapolado para o real em **"a tenth of a second"** (~100 ms); não aumenta latência percebida porque cada frame interpola em direção ao dado mais recente (que se move junto com a mão).

**Regras de gameplay sobre o estado de tracking:**
- "Hands don't drop objects when off camera" — regra de design: objeto segurado **nunca** é solto por perda de tracking.
- Drop (intencional) só dispara quando: confiança "high" **e** não-pinching por **75 ms contínuos**; ao recuperar tracking, espera **15 ms** antes de testar drop; os thresholds de grab e drop são **diferentes** (histerese).
- Arremesso com tracking perdido no meio: constroem o vetor de lançamento a partir de (a) velocidade do buffer 40 ms atrás se há dados contínuos nos últimos 80 ms; (b) senão, buffer de todas-as-confianças se velocidade > 50 cm/s na direção frontal; (c) senão, vetor do ponto-de-perda→posição-atual (60%) combinado com direção do olhar (40%), magnitude × 0,4.
- Mantêm **buffer de 1 s** de transforms/velocidades para reconstruir eventos.
- Lição de design explícita: "design your interactions in a way that ensures players keep their hands out in front of them, at a height and length that is tracked well".

Outros artefatos Meta na mesma linha: `UHandTrackingFilterComponent` do sample oficial Unreal "detects when hand tracking is lost and **holds the last known hand position with decay**, preventing sudden jumps when tracking resumes" ([developers.meta.com/vr/documentation/unreal/unreal-sample-hand-gameplay](https://developers.meta.com/vr/documentation/unreal/unreal-sample-hand-gameplay/)); Wide Motion Mode (Quest 3+) "display[s] plausible hand poses even when the hands are outside the headset's field of view" usando body tracking como fallback, com aviso de pequena regressão de acurácia na transição de volta ([developers.meta.com/vr/documentation/unity/unity-wide-motion-mode](https://developers.meta.com/vr/documentation/unity/unity-wide-motion-mode/)); Hand Tracking 2.1 focou em "reduce tracking loss and predict future positions better… Recovery times have also been greatly reduced after incurring a loss when hands fall outside the FOV" ([developers.meta.com/vr/blog/hand-tracking-improvements-v2-1](https://developers.meta.com/vr/blog/hand-tracking-improvements-v2-1/)).

### 2.2 Peloton Guide (fitness com câmera na TV)

Da apresentação do VP de AI/CV da Peloton no Embedded Vision Summit — [PDF oficial](https://www.edge-ai-vision.com/wp-content/uploads/2023/10/T1T06_Nichani_Peloton_2023.pdf):

- Slide "Robustness Driven through UI and Nudging": os edge cases — **brightness, occlusion, camera tilt/distance, multiple people** — são tratados por **nudging de UI**; "Orientation nudging occurs in all time-based and rep tracking workouts **to minimize inaccuracies due to occlusion**" (orientam o usuário a se posicionar de lado/frente conforme o exercício).
- Filosofia explícita: "ML and UI work together to ensure that member has a **robust experience without introducing friction**".
- Métricas de fairness fatiadas por body type/skin tone/gender com true positive rate por exercício (ex.: Squat 99,7–100%, Dumbbell Swing 96–100%) — o modelo é avaliado por fatia, não em média.
- O Movement Tracker é tolerante por design: o "sweat drop" enche se você se move ~75% do intervalo, e qualquer movimento conta — resenha independente: [connectthewatts.com/2022/04/11/peloton-guide-review](https://connectthewatts.com/2022/04/11/peloton-guide-review/).
- Manual do usuário prescreve setup: ficar **dentro de ~2 m** da câmera, altura 0,9–1,8 m, evitar luz direta/janelas atrás, evitar espelhos/TVs/movimento de fundo, roupas contrastando com o fundo — [manual oficial](https://m.media-amazon.com/images/I/C1e-PuDXIXL.pdf).

### 2.3 Just Dance Camera Controller (Ubisoft, 2023 beta → 2026 oficial)

- Usa um modelo de deep learning existente que estima o jogador como **esqueleto 3D**, compara com os movimentos do coach e produz score por algoritmo de comparação ML próprio (distâncias, ângulos, orientações, movimentos) — [Ubisoft dev blog, out/2025](https://www.ubisoft.com/en-us/game/just-dance/2026/news-updates/2UBGhF4xWMLAVVFMmTCWwn/revolutionising-motion-gaming-the-camera-controller-feature).
- 1,5 ano de P&D full-time; treinaram modelo específico com "own dance motion database with help from volunteers within the Just Dance production team"; ajustaram regras observando streams e feedback de top players — [Xbox Wire, out/2025](https://news.xbox.com/en-us/2025/10/14/just-dance-2026-camera-controller/).
- **Não há documentação pública de como tratam dropout/oclução frame a frame** — lacuna declarada. O fato arquitetural relevante: o score é uma comparação **agregada ao longo da coreografia** (não um gate booleano por frame), e o jogo jamais pausa a música por tracking — a coreografia continua; o custo de frames ruins aparece no score, não em interrupção.

### 2.4 Kinect (a referência histórica dos motion games AAA)

**Joint states**: o Kinect for Windows emite por junta `Tracked` / `Inferred` / `NotTracked` — "A tracked joint that cannot be seen by the camera is inferred. That is, the joint position is calculated from surrounding joint data rather than captured by the camera" ([TrackingState enumeration, Kinect v2](https://raw.githubusercontent.com/Kinect/Docs/553f7c37ca8327003dc7b1990a0dcc6bc9118d5c/Kinect4Windows2.0/k4w2/Reference/Kinect_for_Windows_v2/Kinect/TrackingState_Enumeration.md)). O Azure Kinect segue o mesmo contrato com 4 níveis e emite junta ocluída como "predicted joint pose" com `CONFIDENCE_LOW` ([referência oficial](https://microsoft.github.io/Azure-Kinect-Body-Tracking/release/1.x.x/group__btstructures_ga8582ddc16801cb72d4d3691bcfc3cddb.html); já coberto em `docs/autocalibracao-tolerancia-perda.md`).

**UX guidance oficial (Human Interface Guidelines v1.7, PDF Microsoft — 135 páginas):** [download](http://download.microsoft.com/download/B/0/7/B070724E-52B4-4B1A-BD1B-05CC28D07899/Human_Interface_Guidelines_v1.7.0.pdf)

- p. 94–95 (engagement handoff): "The primary user drops his or her hand but **does not completely disengage** and other users cannot immediately take over control" — histerese de engajamento é comportamento *override do default* que eles recomendam; o challenger precisa completar uma "speed-bump action" (apertar botão) para assumir.
- p. 88–89 (User Viewer): mostrar silhueta/feedback do que o sensor vê "reduces any feeling that the application or Kinect for Windows is buggy, unresponsive, or unexplainably jumpy" — a transparência do estado de tracking é parte da solução de UX.
- p. 63: "You can also prompt people to move into the appropriate field of view whenever they're **cropped, too close, or too far back**" — nudging, não pausa.
- p. 43: tracking mais estável de frente para o sensor; mãos ao lado do corpo são mais rastreáveis que na frente do corpo; máximo 30 fps — "For very fast gestures, consider skeleton tracking speed and frames-per-second limitations".

**Exemplo de jogo publicado (teatro/mocap)**: no Experimenting with Shakespeare (Kinect), "If a player's tracking is lost (typically due to leaving the space or occlusion from another player), their avatar disappears, and the sync line returns to help them repossess their character" — degradação para re-aquisição guiada, não erro fatal ([shakesperiment.tome.press, Act IV](https://shakesperiment.tome.press/chapter/act-iv-if-looking-liking-move-motion-capture-and-the-optics-of-collaboration/)).

### 2.5 Outros

- **Kemtai** (fisioterapia/fitness, validado contra Vicon): marketing reivindica "Advanced Occlusion Handling — maintains tracking in challenging conditions or when body parts are partially obscured" e estabilidade "even with varied lighting, clothing, background, and body type" — e explicitamente **não** usa modelos open-source: "Open source models are a fast way to a demo and a dead end after that" ([kemtai.com/our-computer-vision](https://kemtai.com/our-computer-vision/), [LinkedIn Kemtai Vision](https://www.linkedin.com/posts/kemtai_seven-years-five-generations-three-model-activity-7517834458155356160-Q6yH)). Evidência de que a camada de robustez temporal é tratada como diferencial proprietário — não vem de graça no modelo base.
- **Magic Leap 2** (SLAM, não pose, mas o padrão de UX): "The Magic Leap 2 lets developers manage their own tracking loss behavior – some developers may want to pause the update loop and display a splash image, while others may want the app to continue playing" — a plataforma delega; pausar é uma escolha, não o default ([forum.magicleap.cloud](https://forum.magicleap.cloud/t/fallback-to-imu-only-tracking-in-low-light-conditions/5780)).

**Padrão convergente**: nenhum produto de referência pausa/interrompe na primeira rajada. O espectro é: coast/extrapola com damping (Meta) → agrega no score sem penalizar diretamente (Just Dance, Peloton) → nudging de UI para corrigir a causa (Peloton, Kinect HIG) → pausa só como último recurso configurável (Magic Leap).

---

## 3. MediaPipe Pose Landmarker — o que dizem as fontes primárias

### 3.1 `visibility`/`presence` — significado e thresholds

- **Definição do model card BlazePose GHUM 3D** (PDF oficial Google, 16/abr/2021, embutido em [huggingface.co/litert-community/MediaPipe-PoseLandmarker-Lite](https://huggingface.co/litert-community/MediaPipe-PoseLandmarker-Lite)): "VISIBILITY denotes the probability that a keypoint is located within the frame **and not occluded** either by other body parts or other objects. PRESENCE denotes the probability that a keypoint is located within the frame. It does not indicate whether the keypoint is occluded." Ambos saem como logits e viram probabilidade após sigmoid (no nosso grafo o sigmoid já é aplicado internamente — ver `docs/autocalibracao-tolerancia-perda.md` §2.1).
- **Threshold recomendado pelo autor do modelo**: Valentin Bazarevsky (primeiro autor do BlazePose) no issue #1351: "So reasonable threshold will be **0.5** if you apply the sigmoid or 0.0 if you want to skip this step" — [github.com/google/mediapipe/issues/1351](https://github.com/google/mediapipe/issues/1351). Prática de aplicações: 0,5–0,7 por landmark **usado no cálculo**, e o frame é pulado/segurado quando o ponto necessário está abaixo — nunca derrubar a pose inteira pelo mínimo de um conjunto grande ([sitepoint.com/your-pose-model-gives-you-coordinates-not-meaning](https://www.sitepoint.com/your-pose-model-gives-you-coordinates-not-meaning/), [aifitnessapi.com/guides/improve-pose-detection-accuracy](https://aifitnessapi.com/guides/improve-pose-detection-accuracy)).
- **A semântica correta muda o design do gate**: `presence` alto + `visibility` baixo = ponto **em frame mas ocluído** — situação em que a posição predita ainda é útil para coast. `presence` baixo = ponto fora da imagem — posição é extrapolação pura. Hoje o gate usa `min(vis, presence)` indistintamente (`src/kinematics/math.ts`).
- **Caveat empírico**: no issue #5159, visibilities de juntas claramente visíveis ficaram em 0 numa aplicação de **tênis** (legacy API, thresholds customizados; fechado sem resolução — maintainer só orientou migrar para Tasks API) — [github.com/google-ai-edge/mediapipe/issues/5159](https://github.com/google-ai-edge/mediapipe/issues/5159). Evidência fraca mas diretamente no nosso domínio: em cena dinâmica de tênis, os scores podem ser conservadores demais para servir de gate duro.

### 3.2 Estabilidade temporal interna — o que o modelo faz e não faz

- **Pipeline detector→tracker com ROI loop** (não detecção por frame): "The tracker predicts keypoint coordinates, the presence of the person on the current frame, and the refined region of interest for the current frame. **When the tracker indicates that there is no human present, we re-run the detector network on the next frame**" — [paper BlazePose §2.1, arXiv 2006.10204](https://arxiv.org/abs/2006.10204). Ou seja: há tracking interno real, mas **não há coast/histerese de presença** — um frame com presence < threshold já barra a emissão e dispara re-detecção full-frame no próximo (detalhes do grafo em `docs/autocalibracao-tolerancia-perda.md` §2.2).
- **Premissa de design: cabeça sempre visível.** "We make the strong, yet for AR applications valid, assumption that the head of the person should always be visible for our single-person use case" (paper §2.2); o detector usa face detection como proxy e prediz quadril/escala/rotação a partir da cabeça. Model card lista "Head is not visible" como **out-of-scope**. Implicação direta: jogador que abaixa/sai por cima do frame destrói a detecção inteira, não só os pontos da cabeça.
- **Oclusões são cobertas por treinamento** — §2.6: random-rectangle occlusion augmentation + classificador de visibilidade por ponto, "This allows tracking a person constantly even for cases of significant occlusions, like upper body-only or when the majority of person body is out of scene". O modelo **prevê** os pontos ocluídos e os marca — cabe ao consumidor usar os scores (é o contrato Azure-Kinect-like, não um contrato de ausência).
- **Tolerância de alinhamento do tracker**: augmentations de 10% de shift/scale e 8° de roll; o crop ideal tem margem de 25% ao redor do corpo (model card, "Training Factors"). Corolário: se entre dois frames o corpo se desloca mais que ~10% do próprio tamanho, o ROI do tracker está fora do regime treinado — a falha em FPS baixo/fast motion é estrutural, não bug.
- **Suavização interna ativa na nossa config** (VIDEO + numPoses=1): One Euro `min_cutoff=0,05, beta=80` nos landmarks de imagem e `0,1/40` nos world landmarks + EMA α=0,1 só em `visibility` (fontes e números já auditados em `docs/auditoria-mediapipe.md` #1 e `docs/autocalibracao-tolerancia-perda.md` §2.1). Confirmado pelo maintainer no issue #4507: smoothing ligado automaticamente em VIDEO/LIVE_STREAM com numPoses=1 a partir da 1.2.3 — [github.com/google-ai-edge/mediapipe/issues/4507](https://github.com/google-ai-edge/mediapipe/issues/4507).
- **Timestamps afetam a filtragem**: o 1€ interno recalcula a frequência a partir do Δt real entre pacotes (`one_euro_filter.cc`: `frequency_ = 1.0 / (Δt)` — [código](https://raw.githubusercontent.com/google-ai-edge/mediapipe/master/mediapipe/util/filtering/one_euro_filter.cc)); maintainer orienta usar "the time of the video frame (rather than the current time)" — [issue #4715](https://github.com/google-ai-edge/mediapipe/issues/4715). Diferentes frame rates produzem filtragem diferente — reportado em [issue #2497](https://github.com/google-ai-edge/mediapipe/issues/2497).

### 3.3 Modos de falha conhecidos

| Falha | Evidência primária |
|---|---|
| **Movimento explosivo / FPS baixo**: landmarks temporalmente descolados, "carried away" — squat: pés/quadril afundam como se o modelo predissesse queda; pior em FPS baixo. Issue **aberto, sem fix** (#6239, fev–mar/2026, confirmado pelo maintainer que pediu repro) | [github.com/google-ai-edge/mediapipe/issues/6239](https://github.com/google-ai-edge/mediapipe/issues/6239) |
| **Luz/ruído/movimento degradados aumentam jitter**: "When degrading the environment light, noise, motion or face overlapping conditions one can expect degradation of quality and increase of 'jittering'" | Model card BlazePose GHUM 3D, Limitations/Environment ([PDF](https://huggingface.co/litert-community/MediaPipe-PoseLandmarker-Lite/resolve/main/Model%20Card%20BlazePose%20GHUM%203D.pdf)) |
| **Cabeça fora de frame / >4 m / múltiplas pessoas**: explicitamente out-of-scope | Model card, "Out-of-scope applications" |
| **Parcial sem torso/cabeça não é nem detectado**: "A person cropped by the frame with no torso or head in view is not found at any setting, because the detector that feeds the landmarker anchors on a torso" | [react-native-pose-detection docs](https://github.com/khalid999devs/react-native-pose-detection/blob/main/guides/reference/pose-camera.md) (medido contra `pose_landmarker_full`) |
| **Distância recomendada 2–4 m** para boa qualidade | resposta oficial sgowroji em [issue #2940](https://github.com/google-ai-edge/mediapipe/issues/2940) e mediapipe.readthedocs.io pose ("single person located 2-4 meters from the camera") |
| **ROI além do crop**: o modelo tolera corpo parcialmente fora de cena *uma vez trackeado* (upper-body-only funciona — paper §2.6/Fig. 5), mas a **re-detecção** inicial exige torso/cabeça — assimetria importante: perder o tracking é muito pior que nunca ter |

### 3.4 Lite vs Full vs Heavy — números oficiais

**Acurácia** (PCK@0.2; torso-normalized 2D):

| Dataset/avaliação | Lite | Full | Heavy | Fonte |
|---|---|---|---|---|
| Yoga | 90,2 | 95,5 | 96,4 | [mediapipe.readthedocs.io/en/latest/solutions/pose.html](https://mediapipe.readthedocs.io/en/latest/solutions/pose.html) "Pose Estimation Quality" |
| Dance | 92,5 | 96,3 | 97,2 | idem |
| HIIT | 93,5 | 95,7 | 97,5 | idem |
| PDJ médio geográfico (14 regiões, model card) | 87,0 ± 2,0 | 91,8 ± 1,4 | 94,2 ± 1,3 | Model card PDF p. 6 |
| Range de fairness geográfica | 6,5 | 4,8 | 4,8 | idem |
| Range skin tone | 7,3 | 7,0 | 5,7 | idem p. 7 |
| Paper original (AR / Yoga, modelos 2D antigos) | 79,6 / 77,6 | 84,1 / 84,5 | — | [arXiv 2006.10204, Table 1](https://arxiv.org/abs/2006.10204) |

**Latência oficial**:

| Plataforma | Lite | Full | Heavy | Fonte |
|---|---|---|---|---|
| Pixel 3 TFLite GPU | 20 ms | 25 ms | 53 ms | mediapipe.readthedocs.io pose, tabela de latência |
| MacBook Pro 15" 2017 | 25 ms | 27 ms | 38 ms | idem |
| Pixel 3 XNNPACK CPU | ~44 fps (≈23 ms) | ~18 fps (≈56 ms) | ~4 fps (≈250 ms) | Model card PDF p. 1 |
| Pixel 3 TFLite GPU (fps) | ~49 fps | ~40 fps | ~19 fps | idem |

**Leitura para gameplay**: no delegate GPU (nosso caso nominal), Full custa +5 ms/frame sobre Lite (+25%) e entrega +3,8 a +5,3 pontos de PCK nos datasets mais próximos de corrida/dança/HIIT — e o gap de fairness/robustez também melhora. Como 20→25 ms ainda cabe em 30–40 fps de pipeline e nosso round-trip já está abaixo de 33 ms em GPU saudável (`docs/pesquisa-pipeline-cv.md` §1), **Lite é muito provavelmente uma falsa economia**: a diferença de qualidade se traduz diretamente em menos frames de baixa confiança (menos `lost` espúrio), enquanto o custo de latência é pequeno. Heavy (+28 ms sobre Full) só caberia a 15–20 fps de inferência — trade-off ruim para swing de ~250 ms. No fallback CPU, Lite é o único viável (44 vs 18 fps) — argumento para modelo **adaptativo por delegate**.

---

## 4. Coerência temporal — técnicas com evidência de produção

### 4.1 One Euro filter — tuning correto

- Paper original: [Casiez, Roussel & Vogel, CHI 2012](https://gery.casiez.net/publications/CHI2012-casiez.pdf); tuning oficial em [gery.casiez.net/1euro](https://gery.casiez.net/1euro/): beta=0, fcmin≈1 Hz; segura parado e **desce fcmin** até jitter parar; move rápido e **sobe beta** até lag aceitável; beta depende das unidades — começar em 0,001/0,0001 e variar por fatores de 10. Implementado no Google Chrome (chrome://credits), "used in Chrome on all Android devices", Unreal Engine, Meta Horizon SDK, Vicon Tracker — ou seja, é o padrão de fato da indústria de interação.
- MediaPipe implementa com frequência **recomputada do Δt real** dos timestamps e normalização por escala do objeto (bbox); derivada com cutoff 1 Hz fixo — [one_euro_filter.cc](https://raw.githubusercontent.com/google-ai-edge/mediapipe/master/mediapipe/util/filtering/one_euro_filter.cc), [landmarks_smoothing_calculator_utils.cc](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/calculators/util/landmarks_smoothing_calculator_utils.cc).
- Como nosso input já vem com 1€ interno agressivo (α≈0,01–0,02 parado — `docs/auditoria-mediapipe.md` #1), a segunda camada do app provavelmente deve ser **mais leve ou removida** onde só suaviza (já apontado em `docs/pesquisa-robustez-gestos.md` §3).
- Variante do tf.js pose-detection: além do 1€ padrão, o low-pass final recebe um **threshold com saturação não-linear**: `result = stored + alpha·threshold·asinh((value − stored)/threshold)` — perto de zero comporta-se linear; deslocamentos grandes crescem só logaritmicamente. É um **cap de outliers embutido no filtro** (spike suppression), com `thresholdCutOff = 0,5` + `thresholdBeta·|edValue|` adaptativo à velocidade — [low_pass_filter.js](https://unpkg.com/@tensorflow-models/pose-detection@latest/dist/shared/filters/low_pass_filter.js), [one_euro_filter.js](https://unpkg.com/@tensorflow-models/pose-detection@latest/dist/shared/filters/one_euro_filter.js). Config do MoveNet: `frequency 30, minCutOff 2,5, beta 300, derivateCutOff 2,5` — [constants.ts](https://github.com/tensorflow/tfjs-models/blob/master/pose-detection/src/movenet/constants.ts).
- MediaPipe também tem `RelativeVelocityFilter` (janela de velocidades recentes; "higher window_size adds to lag and to stability; lower velocity_scale adds to lag and to stability") como alternativa ao 1€ em algumas soluções — [relative_velocity_filter.h](https://raw.githubusercontent.com/google-ai-edge/mediapipe/master/mediapipe/util/filtering/relative_velocity_filter.h).

### 4.2 Kinect — Holt double exponential smoothing + jitter radius + clamp (produção AAA)

Do white paper oficial "Skeletal Joint Smoothing" (Mehran Azimi, Microsoft ATG) — [learn.microsoft.com/.../jj131429](https://learn.microsoft.com/en-us/previous-versions/windows/kinect-1.8/jj131429(v=ieb.10)):

- **Dois tipos de ruído, dois tratamentos**: "the relatively small white noise that is always present… the other is temporary spikes caused by inaccuracy, which happen when the joint has an inferred tracking state. Since these noises have different characteristics, different filtering techniques should be used for each… developers need to use a combination of two or three filtering techniques."
- **Suavização adaptativa por tracking state**: "apply a more aggressive smoothing filter when a joint's state is inferred… adaptively update the filter parameters based on the joint's tracking state. Also, filters that are specifically more powerful in removing spike noise should be applied when a joint's state is inferred."
- **Parâmetros do filtro built-in** (Holt double exponential + jitter removal + overshoot control): Smoothing/Correction ∈ [0,1]; Prediction = frames à frente; JitterRadius (m) clampa jitter; MaxDeviationRadius (m) clampa o quanto o filtrado pode desviar do cru. Presets oficiais ([joint filtering docs](https://learn.microsoft.com/en-us/previous-versions/windows/kinect-1.8/jj131024(v=ieb.10))): **default p/ gesture recognition em jogos** `{0,5; 0,5; 0,5; 0,05 m; 0,04 m}`; menus `{0,5; 0,1; 0,5; 0,1; 0,1}`; muito suave/alta latência `{0,7; 0,3; 1,0; 1,0; 1,0}`.
- **Latência**: "User research shows that **72% of people start noticing this delay when latency is more than 100 msec**, and therefore it is suggested that developers aim for an overall latency of 100 msec." Forecasting de ~2 frames pode reduzir ~66 ms de latência em caso ideal, mas amplifica overshoot — corrigir com restrições cinemáticas (comprimento ósseo, limites de hinge joints).
- **Regras operacionais**: usar timestamps reais e **interpolar os pontos faltantes** quando frames caem; "**reset the filter when a skeleton is lost**"; filtrar por junta e por uso (mão rápida ≠ espinha; avatar ≠ gesture scoring).

### 4.3 Kalman — evidência comparativa para controle de jogo

- Edwards & Green (IVCNZ 2014) compararam 4 filtros para controle de videogame com Kinect: Holt do SDK, média móvel, Kalman constant-value e **Kalman WPA (Wiener Process Acceleration)**. Resultado: média/Kalman-CV suavizam bem mas com latência alta; "The WPA Kalman filter was found to have the best overall performance" — [doi 10.1145/2683405.2683453](https://doi.org/10.1145/2683405.2683453) (abstract; full text paywalled).
- DeepSORT: estado 8-D com **modelo de velocidade constante** e track handling: `a_k` conta frames sem associação; track deletada só quando `a_k > A_max` (**max_age = 30 frames nos experimentos**); novas tracks são *tentative* e só confirmam após **3 frames consecutivos** de associação — [arXiv 1703.07402 §2.1](https://arxiv.org/abs/1703.07402); implementação de referência `n_init=3, max_age=30` — [nwojke/deep_sort](https://deepwiki.com/nwojke/deep_sort/2.1-tracker-implementation). É a formulação clássica de **histerese temporal de existência**: confirma rápido o suficiente para não perder objetos reais (3 frames), morre devagar o suficiente para atravessar oclusões (30 frames).
- O tracker do tf.js pose-detection (Google) usa a mesma ideia em produção: `maxAge: 1000` (ms), `minSimilarity 0,2`, keypoint confidence threshold 0,3, mínimo 4 keypoints para associar — [constants.ts](https://github.com/tensorflow/tfjs-models/blob/master/pose-detection/src/movenet/constants.ts) (`DEFAULT_KEYPOINT_TRACKER_CONFIG`).

### 4.4 Votação multi-frame / histerese de estado — evidências convergentes

| Fonte | Entra (confirma) | Sai (desiste) | Janela de graça |
|---|---|---|---|
| DeepSORT | 3 frames consecutivos | 30 frames sem match (~1 s @30 fps) | ~1 s |
| tf.js pose tracker | — | `maxAge` 1000 ms | 1 s |
| Meta First Steps (drop de objeto) | confiança high | 75 ms contínuos de baixa confiança + 15 ms de estabilização pós-retorno | ~90 ms |
| ML Kit pose classification | EMA α=0,2 janela 10 | reset só por **stall de stream > 100 ms**, não por frame ruim | ~100 ms+ |
| Kinect engagement (HIG) | speed-bump action deliberada | não desengaja ao baixar a mão | indefinida (até challenger completar ação) |
| VRM retarget (MediaPipe Holistic, dev.to) | — | pose perdida **> 0,5 s** antes de voltar a neutro | 0,5 s |
| Nosso app hoje | 3 frames bons | **4 frames ruins (~133 ms)** | ~133 ms |

Fontes: DeepSORT/tf.js/Meta/ML Kit conforme §4.3 e §2.1; ML Kit EMA: [EMASmoothing.java](https://github.com/googlesamples/mlkit/blob/master/android/vision-quickstart/app/src/main/java/com/google/mlkit/vision/demo/java/posedetector/classification/EMASmoothing.java) (`RESET_THRESHOLD_MS = 100`); VRM: [dev.to/kiarina](https://dev.to/kiarina/real-time-webcam-to-vrm-retargeting-with-mediapipe-holistic-173-fps-on-m1-max-4be3); Kinect HIG p. 94–95.

Observação: os 75–100 ms da Meta/ML Kit são para **reagir a um gesto/ação** dentro de uma stream contínua; os 0,5–1 s do DeepSORT/tf.js/VRM são para **declarar perda de identidade/presença**. Nosso `lost` alimenta os dois papéis ao mesmo tempo — e o papel "presença do jogador" é o que está com a constante errada (133 ms). Vale separar: reação rápida a gesto (curto) vs desistência de presença (longo).

### 4.5 Coasting/extrapolação — o padrão concreto

Síntese das fontes (Meta §2.1 + DeepSORT §4.3 + Kinect §4.2):

1. Manter estado cinemático (posição + velocidade, idealmente por landmark ou por canal derivado) dos últimos frames **bons**.
2. Durante frames ruins: integrar velocidade com **damping por frame** (Meta) ou modelo constant-velocity puro (DeepSORT) — para movimento de jogo, o damping é essencial porque o movimento humano não é balístico por mais que algumas centenas de ms.
3. **Nunca interpolar em direção ao dado ruim** — o dado ocluído/inferido é enviesado (Kinect white paper: spikes temporários que "go away as the joint tracking state goes back to TRACKED").
4. No retorno: blend curto (~100 ms) do extrapolado para o medido, sempre mirando o dado mais recente.
5. Timeout de coast: após ~0,5–1 s sem dados bons, congelar/neutralizar — e só então considerar degradação de gameplay.

---

## 5. Qualidade do frame de câmera — o que importa de fato

1. **Exposição/motion blur é a alavanca física dominante em movimento rápido.** PeTrack (documentação de software de tracking de pedestres em pesquisa): 24–30 fps bastam para caminhada (≤7 cm/frame), "**For running people, increasing the frame rate can improve tracking**"; exposição de **1/150 s é suficiente para pedestres andando e 1/500 s para correndo** — [petrack.readthedocs.io/planning/camera](https://petrack.readthedocs.io/en/latest/planning/camera.html). Tese de Handa (Imperial College): frame rate alto implica teto menor no shutter time → **menos motion blur, porém mais ruído** — trade-off dependente de iluminação — [doc.ic.ac.uk/~ajd/Publications/handa_phd2013.pdf](http://www.doc.ic.ac.uk/%7Eajd/Publications/handa_phd2013.pdf). TOG "The need 4 speed": sensores de 30 fps "allow for large inter-frame motions to occur that make such tracking problematic… longer exposure times produce artifacts due to motion blur" — [doi 10.1145/3272127.3275062](https://dl.acm.org/doi/10.1145/3272127.3275062).
2. **Implicação para getUserMedia**: a câmera a 60 fps fisicamente não pode expor mais que 1/60 s por frame — mesmo que o processemos só 1 em 2 frames, o blur de um swing rápido cai pela metade vs 30 fps. A constraint `frameRate: {ideal: 60}` (`src/App.tsx:148`) está correta; `ideal` (não `exact`) negocia para baixo em câmeras de 30 fps sem falhar — comportamento conforme spec mediacapture ([w3c.github.io/mediacapture-main](https://w3c.github.io/mediacapture-main/)).
3. **Controle fino de exposição existe, mas só Chromium**: a extensão Image Capture expõe `exposureMode`/`exposureTime` como track constraints; implementação: Windows desde Chrome 60/76, Linux/ChromeOS sim, macOS desde 111, Android 72 — **ausente em Firefox/Safari** — [w3c/mediacapture-image implementation-status.md](https://github.com/w3c/mediacapture-image/blob/main/implementation-status.md), [spec](https://www.w3.org/TR/image-capture/). Ou seja: pode-se tentar capar exposição via `applyConstraints` em Chrome desktop (degradar graciosamente onde não houver), mas fixar exposição curta em ambiente escuro escurece a imagem e aumenta ruído de gain — é um experimento, não um default.
4. **Resolução acima de ~640p tem pouco valor para o modelo**: o grafo redimensiona para o input da rede de qualquer forma — "the first thing mediapipe graph does is to downsize the image into whatever the model expects (regardless of input image size)" (mcclanahoochie, [issue #238](https://github.com/google/mediapipe/issues/238)); o landmarker opera no crop 256² da ROI. Medição independente (webcam real, CPU): pedir 1280×720 derrubou o pipeline para 16,5–21,6 fps vs 29,9 fps a 640×480 — câmera comum ignora o pedido ou custa mais banda/decode — [diyor-ai/gesture-control-system README](https://github.com/diyor-ai/gesture-control-system). Resolução maior só ajuda se o corpo ocupar poucos pixels (pessoa longe) — e aí o correto é UX de enquadramento (2–4 m, corpo 70–90% da altura), não mais pixels.
5. **Iluminação frontal/uniforme e contraste de roupa** são prescritos por todos os vendors (Peloton manual §2.2; Meta: "bright, even lighting… same amount of light as you would have in the living room when you have guests over" — [meta.com/help/quest](https://www.meta.com/help/quest/598701621088668/)). Para webcam de topo de monitor, a iluminação do quarto costuma ser traseira/lateral — o nudging de setup é parte do sistema, não opcional.

---

## 6. Degradação graciosa no gameplay — o que shipados fazem

Síntese por produto (fontes nas seções 2 e 4):

| Situação | Comportamento de produção observado |
|---|---|
| Rajada curta (< ~300 ms) | **Invisível ao jogador**: coast/extrapolação com damping (Meta), filtro absorve (Kinect smoothing), score agregado nem nota (Just Dance/Peloton). Nada de UI. |
| Perda média (~0,3–1 s) | Avatar/objeto **congela ou desacelera** na última pose boa; input derivado vai a zero suavemente, não em degrau; objeto segurado **não é solto** (Meta); nenhuma pausa. |
| Perda longa (> 1–2 s) | UI de aviso/transparência: User Viewer/silhueta (Kinect HIG), sync line de re-aquisição (Shakespeare), nudging "afaste-se/ilumine" (Peloton); o app *continua* — pausa total é opt-in do dev (Magic Leap). |
| Retorno | Blend de ~100 ms sem snap (Meta); **sem countdown/restart de posição** em nenhuma fonte; re-engajamento é imediato quando o usuário já era o primário (Kinect handoff). |
| Causa raiz persistente | Nudging de setup (distância, iluminação, tilt) — trata-se a causa, não o sintoma (Peloton, Kinect HIG p. 63). |

O anti-padrão do nosso app hoje — pausar a corrida e reiniciar com countdown de 3 s (`runGate.ts:51-54`) — não tem correspondente em nenhuma fonte primária encontrada; é mais punitivo que qualquer referência, inclusive as de 2010–2013 (Kinect).

---

## 7. Implementações open-source / artefatos que valem estudar

| Recurso | O que extrair | URL |
|---|---|---|
| Meta First Steps blog | Algoritmo completo de 5 passos (stillness-freeze → jitter-smooth → quality-gate → extrapolate+damping → blend-back ~100 ms) + regras de drop/grab com histerese | [developers.meta.com/vr/blog/adding-hand-tracking-to-first-steps](https://developers.meta.com/vr/blog/adding-hand-tracking-to-first-steps/) |
| Kinect Skeletal Joint Smoothing White Paper | Teoria dos dois ruídos, suavização adaptativa por tracking state, presets de parâmetros, reset-on-loss, regra dos 100 ms | [learn.microsoft.com/.../jj131429](https://learn.microsoft.com/en-us/previous-versions/windows/kinect-1.8/jj131429(v=ieb.10)) |
| Kinect Human Interface Guidelines v1.7 (135 p.) | Engagement hysteresis, User Viewer/transparência, nudging de enquadramento | [PDF Microsoft](http://download.microsoft.com/download/B/0/7/B070724E-52B4-4B1A-BD1B-05CC28D07899/Human_Interface_Guidelines_v1.7.0.pdf) |
| tfjs-models pose-detection | 1€ com saturação asinh anti-spike; crop ROI suavizado α=0,9; reset→full-frame re-detect quando `pose.score < 0,25`; tracker `maxAge 1000 ms` | [detector.ts](https://github.com/tensorflow/tfjs-models/blob/master/pose-detection/src/movenet/detector.ts), [constants.ts](https://github.com/tensorflow/tfjs-models/blob/master/pose-detection/src/movenet/constants.ts), [low_pass_filter.js](https://unpkg.com/@tensorflow-models/pose-detection@latest/dist/shared/filters/low_pass_filter.js) |
| DeepSORT | max_age/n_init — a referência de histerese de existência em tracking | [arXiv 1703.07402](https://arxiv.org/abs/1703.07402), [nwojke/deep_sort](https://github.com/nwojke/deep_sort) |
| ML Kit pose classification sample | EMA α=0,2/janela 10 + reset só por stall >100 ms; histerese de limiar duplo para rep counting | [EMASmoothing.java](https://github.com/googlesamples/mlkit/blob/master/android/vision-quickstart/app/src/main/java/com/google/mlkit/vision/demo/java/posedetector/classification/EMASmoothing.java), [pose_classification.md](https://github.com/google-ai-edge/mediapipe/blob/3eb8983cde1517fdff4abbfb33586316af6d45be/docs/solutions/pose_classification.md) |
| MediaPipe filtering utils | OneEuro/RelativeVelocity/LowPass de referência em C++ | [mediapipe/util/filtering](https://github.com/google-ai-edge/mediapipe/tree/master/mediapipe/util/filtering) |
| Unreal hand gameplay sample (Meta) | `UHandTrackingFilterComponent`: hold last known position with decay | [developers.meta.com/vr/documentation/unreal/unreal-sample-hand-gameplay](https://developers.meta.com/vr/documentation/unreal/unreal-sample-hand-gameplay/) |
| react-native-pose-detection | Decisões de produto documentadas: smoothing auto-off para 1 pose, reset de filtro quando frames param > 2,5 intervalos, minConfidence 0,6 single-pose | [guides/reference/pose-camera.md](https://github.com/khalid999devs/react-native-pose-detection/blob/main/guides/reference/pose-camera.md) |
| Issues mediapipe #6239/#4507/#2497/#4715 | Fast-motion decoupling (aberto), confirmação de smoothing interno, dependência de timestamps | [#6239](https://github.com/google-ai-edge/mediapipe/issues/6239), [#4507](https://github.com/google-ai-edge/mediapipe/issues/4507), [#2497](https://github.com/google-ai-edge/mediapipe/issues/2497), [#4715](https://github.com/google-ai-edge/mediapipe/issues/4715) |
| diyor-ai/gesture-control-system | Medição real webcam: 640×480→29,9 fps vs 720p→16,5–21,6 fps | [github.com/diyor-ai/gesture-control-system](https://github.com/diyor-ai/gesture-control-system) |
| 1€ filter site | Procedimento de tuning em 2 passos + implementações verificadas | [gery.casiez.net/1euro](https://gery.casiez.net/1euro/) |

## 8. Lacunas declaradas

- **Nenhum número público** de como o Just Dance Camera Controller trata dropout frame a frame (algoritmo proprietário; só arquitetura geral publicada).
- Não encontrei requisito público de certificação Xbox/AAA sobre comportamento em tracking loss — a evidência de "padrão AAA" vem das guidelines oficiais do Kinect e dos casos documentados, não de TCRs.
- A comparação Lite/Full é de PCK estático por frame; **não há benchmark publicado de taxa de dropout temporal** (frames vazios/minuto em vídeo) por variante de modelo — a hipótese "Full reduz lost espúrio" precisa ser medida no nosso harness (`scripts/pose-bench.html` + replay de fixtures).
- O threshold ideal de `minPosePresenceConfidence` (hoje 0,5 default) para reduzir frames vazios sem admitir fantasmas não é documentado em nenhuma fonte — o efeito de baixá-lo é um experimento local.

---

## 9. Recomendações práticas

Ordenadas por razão impacto/esforço esperada. "Impacto" = redução de `lost` espúrio ou do custo de UX por rajada. Toda mudança de comportamento temporal deve vir com teste determinístico de fixture (política do repo).

### Tier 1 — barato, alto impacto (fazer primeiro)

1. **Separar "reação a gesto" de "desistência de presença" no gate.** Manter a confirmação atual (3 frames bons ≈ 90 ms) mas aumentar a saída para `lost` de 4 frames (~133 ms) para uma janela de **~500–1000 ms** de frames ruins — a convergência das fontes (DeepSORT 1 s, tf.js 1 s, VRM 0,5 s) é unânime em ordem de grandeza; mesmo 500 ms já elimina a maioria das rajadas de motion blur/oclusão de swing. Implementação: contar por `timestampMs`, não por frames (o Kinect white paper exige contabilizar Δt real; frames caem). Custo: mudança de constante + testes. Fontes: §4.4 tabela.
2. **Não pausar nem reiniciar countdown em perda transitória.** Trocar o comportamento do `RunGate`: durante rajada < limiar (ex.: 1–2 s), a corrida **continua** com input degradado (velocidade decaindo suavemente — ver item 3) e um aviso visual discreto (transparência tipo User Viewer — Kinect HIG p. 88–89); pausa só sustentada; retorno retoma **sem** countdown de 3 s quando o jogador nunca saiu. Nenhum produto de referência re-onboarda o usuário após uma rajada — o countdown atual é o item mais punitivo do sistema. Fontes: §2, §6.
3. **Coast com damping nos controles contínuos.** Em vez de `sprintSpeed01` cair a 0 no primeiro frame não-`tracked`, manter a última cadência válida decaindo (ex.: ×0,9/frame ou half-life ~150 ms) por até ~500 ms — é exatamente o padrão Meta (velocidade integrada + damping por frame ruim) adaptado ao nosso canal escalar. Evita que o corredor "trave" no ar a cada rajada. Fontes: §2.1 passo 4, §4.5.
4. **Gate por landmark-usado, não min() global.** O gate de torso para cadência/salto já usa os 4 centrais — mas o swing usa `world` de punho+torso com o mesmo threshold 0,55, e `min()` de 5 pontos é estatisticamente muito mais estrito que por ponto. Adotar: (a) threshold 0,5 (recomendação do autor do BlazePose, §3.1); (b) frame ruim **segura estado** do detector em vez de resetar — o reset do `SwingDetector`/`CadenceTracker` em `lost` (actionPipeline.ts:59-63,74) destrói memória de tracking que sobreviveria à rajada; com a janela de graça do item 1, o reset só aconteceria em perda real. Fontes: §3.1, §4.2 ("reset the filter when a skeleton is lost" — mas só quando realmente perdido).

### Tier 2 — médio esforço, alto impacto

5. **Avaliar Lite → Full com benchmark real.** Trocar o `.task` em GPU e medir: taxa de frames vazios/minuto, p95 de latência de round-trip, taxa de `lost` espúrio em fixtures gravadas. A evidência estática (+3,8–5,3 PCK por +5 ms GPU) sugere forte ganho de robustez temporal grátis; CPU fallback permanece Lite. Se o download de +25 MB for problema, considerar carregar Full só quando delegate=GPU. Fontes: §3.4. **A hipótese de dropout temporal não está publicada — medir antes de adotar** (lacuna §8).
6. **Blend-back de ~100 ms após rajada.** Quando os pontos voltam, interpolar posições/ângulos derivados do valor coasted para o medido ao longo de ~100 ms mirando o dado mais recente — evita o snap que redispara detectores de velocidade (swing falso no retorno). Meta documenta que isso **não** adiciona latência percebida. Fonte: §2.1 passo 5.
7. **Spike suppression não-linear (asinh) ou clamp de desvio nos canais derivados.** O tf.js produção usa `threshold·asinh(Δ/threshold)` dentro do low-pass; o Kinect usa MaxDeviationRadius. Aplicável diretamente nos canais escalares (`torsoVertical`, velocidade de punho) para que um frame ruim com coordenada teleportada não contamine cadência/swing mesmo antes de qualquer gate. Fontes: §4.1, §4.2.
8. **Usar `captureTime`/`frame.timestamp` real nos timestamps enviados ao grafo.** O 1€ interno deriva frequência do Δt dos timestamps; hoje usamos `performance.now()` no scheduling, não o instante de captura — maintainer recomenda "time of the video frame" (#4715) e a spec rVFC fornece `metadata.captureTime` (SHOULD) — já apontado em `docs/pesquisa-pipeline-cv.md` §2.1. Impacto: suavização interna corretamente calibrada quando frames caem.

### Tier 3 — oportunista / medir primeiro

9. **Câmera: manter `frameRate: {ideal: 60}` e experimentar cap de exposição em Chromium.** 60 fps já limita exposição a 1/60 s e dobra amostras de um swing de 250 ms; `applyConstraints({exposureTime})` avançado pode reduzir blur ainda mais em Chrome desktop (Windows 76+/macOS 111+/Linux), degradando graciosamente onde ausente — medir efeito em iluminação fraca antes de habilitar por default (imagem escura/ruidosa é pior que blur). Fontes: §5 itens 1–3.
10. **Nudging de setup na UI calibração** (distância 2–4 m — na prática para webcam de mesa: corpo 70–90% da altura do frame, cabeça sempre visível, luz frontal). É o que Peloton/Kinect fazem sistematicamente e custa só UI. O `AutoCalibrator` já mede enquadramento — estender com checagem de cabeça/rosto e orientação de iluminação. Fontes: §2.2, §5.5, §3.3.
11. **Adaptar smoothing por qualidade do frame** (agressivo quando visibility/presence baixos, leve quando altos) — prescrição direta do Kinect white paper §3.6. Só depois de medir o jitter residual real (`docs/pesquisa-robustez-gestos.md` §3 measurement recipe), porque a dupla filtragem atual já é excessiva em repouso. Fontes: §4.2.
12. **Reduzir `minPosePresenceConfidence` abaixo de 0,5?** Hipótese para diminuir frames vazios; nenhuma fonte quantifica o trade-off. Se testado, medir taxa de falso-positivo de pose (fantasma em fundo) junto — lacuna §8.

### Não fazer

- **Não** interpolar em direção a landmarks de baixa confiança: viés documentado (Kinect white paper; Meta tentou e reverteu — "ended up being even more frustrating").
- **Não** subir resolução de captura esperando robustez: modelo downsamples internamente; custo é throughput (medição 720p ≈ ½ fps de 480p).
- **Não** adicionar mais uma camada de 1€ nos landmarks: já há dupla filtragem interna+app não calibrada (`docs/auditoria-mediapipe.md` #1); mexer só após medir.
