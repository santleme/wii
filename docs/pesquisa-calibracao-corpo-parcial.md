# Calibração com corpo parcial e movimento — o que é exigência técnica e o que é design

Data: 25 de novembro de 2026. Estado do código lido em `main` (`7159acb`, merge do PR #23). Pesquisa contra fontes primárias: paper e model card do BlazePose, documentação oficial ML Kit/MediaPipe, issue oficial do MediaPipe, código-fonte do MediaPipe, literatura de validação contra Vicon e literatura de detecção de repouso/linha de base. Complementa `docs/pesquisa-deteccao-pelo-torso.md`, `docs/pesquisa-exposicao-minima-calibracao.md`, `docs/autocalibracao-tolerancia-perda.md` e `docs/pesquisa-robustez-gestos.md`.

**Pergunta**: a calibração precisa mesmo do corpo inteiro? Qualquer movimento precisa reiniciar a tentativa? Existe saída técnica para não bloquear o jogo até uma calibração perfeita?

## Veredicto curto

1. **Corpo inteiro não é exigência técnica.** Para o BlazePose, rosto + ombros + quadris é uma configuração dentro do envelope de treino; o próprio time do MediaPipe diz que o modelo full-body passou a tratar bem lower-body fora do quadro e recomenda simplesmente ignorar os landmarks 25–32 quando eles não interessam. Joelhos, tornozelos e pés não são necessários para corrida-no-lugar nem para salto no design atual.
2. **O `main` já implementou boa parte disso.** O PR #22 (`feat/torso-detection`) tornou o núcleo de calibração ombros+quadris, e os testes atuais provam calibração de corrida sem joelhos/tornozelos/punhos. O README, porém, ainda diz “corpo inteiro”, e a experiência real continua mais rígida que o requisito técnico.
3. **“Qualquer mexida reinicia” não é exigência técnica.** É uma decisão conservadora do `AutoCalibrator`: uma âncora de quietude compara landmarks em coordenadas de imagem e mundo, e qualquer deslocamento acima da tolerância descarta as amostras acumuladas. Isso protege as medianas contra mistura de posturas, mas é mais forte do que o necessário.
4. **O jogo não precisa ficar bloqueado esperando o perfil.** No pipeline atual, cadência e salto já são auto-referenciados e não leem `CalibrationProfile`. O bloqueio acontece porque `ActionPipeline.update()` retorna cedo quando `calibration` é `undefined`. Raia e tênis têm dependências reais de referência, mas podem ser ativados progressivamente.
5. **Tênis não precisa intrinsecamente dos dois punhos.** O pipeline já mantém um detector por punho e escolhe o braço que swinga. A referência calibrada de punho só é usada no retorno ao repouso depois do swing; o disparo do swing em si é por velocidade. Exigir os dois punhos é uma simplificação de calibração, não uma lei do detector.
6. **A saída técnica é calibração incremental, por característica e não bloqueante**: estimar continuamente escala/ombros, vertical neutra e repouso dos punhos em janelas rolantes; ativar cada controle quando a sua própria evidência convergir; nunca descartar todo o investimento por causa de um landmark irrelevante ou de uma mexida curta.
7. **O que ainda falta é validação com webcam real.** Não há número publicado suficiente para jitter de repouso do Pose Landmarker Lite em webcam comum, nem medida in-app de erro quando o enquadramento corta as pernas. A literatura sustenta a direção, mas os limiares finais precisam ser medidos.

---

## 1. Estado atual do repositório — o que já está resolvido e o que continua causando a dor

### 1.1 O núcleo mínimo já é torso, não corpo inteiro

`src/cv/calibrator.ts` declara explicitamente “Upper-body calibration”: um frame válido precisa apenas dos quatro pontos centrais — ombros `[11,12]` e quadris `[23,24]` — em imagem e mundo. As pernas só melhoram a vertical neutra quando uma postura estendida é observada; os punhos têm cobertura independente. Os gates principais são:

- cobertura de frame válido: `COVERAGE_RATIO = 0.65`;
- span mínimo: `MIN_SPAN_MS = 2000`;
- sinal válido acumulado: `VALID_SIGNAL_MS = 1800`;
- gap temporal máximo creditado: `MAX_SIGNAL_GAP_MS = 350`.

Os testes em `tests/kinematics.test.ts` já cobrem:

- corrida calibra sem nunca ver joelhos, tornozelos ou punhos;
- tênis calibra com punhos visíveis mesmo sem joelhos/tornozelos;
- cadência, passos e salto funcionam com pernas e punhos fora do quadro;
- perda curta de tracking entra na cobertura em vez de abortar imediatamente;
- convergência em torno de 2 s no fixture ideal contínuo.

Portanto, a pergunta “a gente não tem pesquisa sobre isso?” tem resposta direta: **sim**. `docs/pesquisa-deteccao-pelo-torso.md` já concluía que a calibração pode ser só-de-tronco e que corrida/salto podem ser detectados por torso. O PR #22 implementou essa direção.

### 1.2 O bloqueio de gameplay ainda é anterior à calibração

Apesar disso, `ActionPipeline.update()` faz isto antes de rodar qualquer detector:

```ts
if (!calibration) {
  this.resetDetectors();
  return { controls: { sprintSpeed01: 0, cadenceSpm: 0, trackingState: 'lost' }, ... };
}
```

Ou seja, **mesmo cadência e salto, que não usam o perfil, são silenciados até existir uma calibração completa**. O comentário de `src/kinematics/cadenceTracker.ts` diz que a cadência é “self-referencing”; `src/kinematics/jumpDetector.ts` diz “no calibration involved”. Esses dois canais só ficam bloqueados porque a composição no pipeline ainda trata o perfil como pré-requisito global.

A raia é diferente: `LaneLeanDetector` precisa de `leanUp0`/`torsoLeanRad0`. O tênis também é diferente: hoje `SwingDetector` se recusa a operar sem `readyWristLocal`. Mas essas dependências são específicas; não justificam bloquear corrida e salto.

### 1.3 A quietude atual é binária, global e sensível a landmarks que não deveriam importar

`src/cv/autoCalibrator.ts` usa:

- `SETTLE_MS = 1000` e `COLLECT_MS = 3000`;
- tolerância de imagem `STILL_TOLERANCE = 0.04`;
- tolerância de mundo `max(0.08 m, 0.2 × largura dos ombros)`;
- núcleo exigido `[11,12,23,24]`;
- no modo tênis, também `[15,16]`.

O problema está em `moved()`/`createAnchor()`:

- para corrida, os pontos monitorados são `[11,12,23,24,25,26,27,28]` — joelhos e tornozelos entram no teste de movimento mesmo sendo opcionais para o perfil;
- para tênis, entram também os punhos;
- se um ponto não estava confiante na âncora e depois aparece confiante, isso sozinho conta como movimento (`!anchoredPoint && point => true`);
- quando `moved()` dispara no fluxo normal, o calibrador é resetado e uma nova âncora começa; quando dispara num frame ruim, a tentativa volta a `framing`.

Há uma razão defensiva documentada no código: se a pessoa se move durante uma perda de tracking e volta, as medianas não devem misturar posturas diferentes. A intenção é correta. O problema é a granularidade: **a proteção vale para qualquer translação e para articulações que não são necessárias ao canal sendo calibrado**, e o preço é descartar todo o investimento.

Nuance importante: os tornozelos/joelhos não são irrelevantes para tudo. `legsVertical()` usa pernas estendidas para estimar a vertical gravitacional melhor que o tronco. Por isso existe até teste que reancora quando os tornozelos aparecem e passam a definir a vertical. Isso não justifica exigir pernas; significa que a fonte da vertical precisa ser escolhida de forma explícita e estável. Reiniciar tudo porque a fonte melhorou é uma implementação simples, não a única solução.

### 1.4 O tênis exige os dois punhos por simplificação do perfil, não porque o detector precise disso

`ActionPipeline` instancia um `SwingDetector` por mão. O disparo (`onset`) usa velocidade lateral/normalizada do punho. `readyWristLocal` é lido principalmente no modo `return`, para rearmar quando o punho volta perto da posição calibrada e a velocidade cai. `docs/pesquisa-robustez-gestos.md` já observa que exigir a posição calibrada pode deadlockar se o jogador descansar o braço em outro lugar, e sugere fallback por velocidade baixa sustentada.

Além disso, `Calibrator` só produz `readyWristLocal` quando **os dois** punhos têm cobertura suficiente no mesmo frame (`leftWrist && rightWrist`). Nada no pipeline de swing exige essa simetria: uma mão pode ser dominante, a outra pode estar fora do quadro, e acessibilidade pode exigir modo de uma mão. É uma lacuna de design.

### 1.5 A documentação pública do app ficou para trás

`README.md` ainda diz “Câmera enquadrando o corpo inteiro para corrida e salto” e descreve calibração de cerca de quatro segundos. `CameraPip` já diz corretamente “cabeça e torso até o quadril”. Essa contradição é parte da experiência ruim: o usuário recebe uma instrução de corpo inteiro mesmo quando o sistema não precisa mais disso.

---

## 2. Evidência primária — corpo parcial é caso suportado, com limites claros

### 2.1 BlazePose foi treinado para operar quando só quadris+ombros são anotáveis

O paper do BlazePose diz, na seção de dataset:

> “We restrict our dataset to those cases where either the whole person is visible, or where hips and shoulders keypoints can be confidently annotated. To ensure the model supports heavy occlusions that are not present in the dataset, we use substantial occlusion-simulating augmentation.”

Fonte: [BlazePose: On-device Real-time Body Pose tracking, arXiv 2006.10204, §2.4](https://arxiv.org/abs/2006.10204).

Na seção de alinhamento e oclusões, o paper diz que o modelo simula oclusões durante treino e introduz um classificador de visibilidade por ponto; isso permite tracking mesmo em “upper body-only or when the majority of person body is out of scene”. Fonte: [arXiv 2006.10204, §2.6](https://arxiv.org/abs/2006.10204).

**Leitura direta**: ombros+quadris não são um hack fora da distribuição; são a condição mínima explícita de anotação/treino.

### 2.2 O time MediaPipe aposentou o modelo upper-body porque o full-body passou a tratar esse caso

Na issue oficial “Where did upper-body pose landmark go?”, o mantenedor `chuoling` respondeu:

> “We previously included an upper-body-only model because the full-body model didn't handle well the cases where the lower body is not visible. However, we've improved the full-body model (across all model complexities: lite, full, heavy) such that it now handles those cases well and a special upper-body-only model is no longer needed. [...] if desired you could simply ignore the pose landmarks that correspond to the lower body (i.e., index 25~32).”

Fonte: [google-ai-edge/mediapipe issue #1995](https://github.com/google-ai-edge/mediapipe/issues/1995).

**Leitura direta**: para corrida/salto por torso, consumir só `[11,12,23,24]` e ignorar `[25..32]` é exatamente o uso recomendado pelo time.

### 2.3 O requisito duro é rosto/cabeça, não pés

A documentação ML Kit diz:

> “The user's face must be present in order to detect a pose. Pose detection works best when the subject's entire body is visible in the frame, but it also detects a partial body pose.”

Fonte: [ML Kit Pose Detection](https://developers.google.com/ml-kit/vision/pose-detection).

O paper explica por quê: um detector de face rápido é usado como proxy de detector de pessoa e produz os parâmetros iniciais de alinhamento. O model card lista “head is not visible” como fora de escopo e também limita pessoas muito distantes (~4 m). Fontes: [arXiv 2006.10204 §2.2](https://arxiv.org/abs/2006.10204); [Model Card BlazePose GHUM 3D](https://developers.google.com/static/ml-kit/images/vision/pose-detection/pose_model_card.pdf).

**Consequência para onboarding**: a instrução mínima honesta é “cabeça, ombros e quadril visíveis”, não “corpo inteiro”. Para tênis, acrescentar “pelo menos a mão da raquete visível” é suficiente como requisito funcional.

### 2.4 Pontos fora do quadro existem na saída, mas não são evidência visual

O model card descreve saída `(x,y,z,visibility,presence)` e define:

- `visibility`: probabilidade de o keypoint estar dentro do frame e não ocluído;
- `presence`: probabilidade de o keypoint estar dentro do frame, sem dizer se está ocluído.

O card também diz que o modelo foi avaliado qualitativamente em pessoas com membros ausentes/próteses e “degrades gracefully by predicting average point location”. Isso é útil para robustez, mas **não** significa que um membro invisível/ausente carregue medida confiável. É previsão de pose média, não observação.

Fonte: [Model Card BlazePose GHUM 3D](https://developers.google.com/static/ml-kit/images/vision/pose-detection/pose_model_card.pdf).

A documentação do Pose Landmarker confirma que saem landmarks normalizados e world landmarks em metros centrados no ponto médio dos quadris, com `visibility`/`presence`. Fonte: [Pose Landmarker — Google AI Edge](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker).

**Consequência**: consumir pernas previstas quando elas estão fora da imagem é perigoso; ignorar essas pernas é seguro. O gate correto é por landmark, não “corpo inteiro ou nada”.

### 2.5 Ombros e quadris são justamente os landmarks mais estruturais do pipeline

Num estudo independente multi-câmera contra Vicon, os erros de posição aumentaram marcadamente abaixo de visibility ~0,5 e a variância aumentou abaixo de ~0,8; um threshold 0,7 preservou 90,6% das observações naquele setup. O mesmo estudo observa que **shoulder e hip landmarks consistentemente tinham alta visibility porque o MediaPipe os usa para determinar a ROI antes de estimar os demais landmarks**.

Fonte: [Chen et al., validação multi-view MediaPipe/Vicon, PMC13766164](https://pmc.ncbi.nlm.nih.gov/articles/PMC13766164/).

Limitações: não é monocular webcam 480p nem Pose Landmarker Lite em jogo; usa reconstrução multi-câmera e exercícios controlados. Ainda assim, é evidência independente na mesma direção: o core ombro-quadril é o substrato mais confiável, enquanto cotovelos/punhos/pernas são mais vulneráveis a oclusão.

### 2.6 O modelo é sensível a ambiente, mas isso não muda a exigência de corpo inteiro

O model card diz que luz ruim, ruído, movimento e sobreposição de face degradam qualidade e aumentam jitter. Também diz que o modelo é sensível à posição/escala/orientação da face. Isso explica falhas reais de calibração em condições domésticas, mas não implica necessidade de corpo inteiro. Implica que feedback de qualidade (face visível, luz, distância, landmarks que faltam) é parte do produto.

Fonte: [Model Card BlazePose GHUM 3D](https://developers.google.com/static/ml-kit/images/vision/pose-detection/pose_model_card.pdf).

---

## 3. Evidência primária — “não se mexer” não precisa significar “estátua ou restart”

### 3.1 O contrato do MediaPipe é emitir melhor esforço por frame + confiança; consumidores devem agregar

O pipeline BlazePose é detector+tracker: o tracker emite landmarks, presença e ROI; quando a presença falha, o detector roda de novo no frame seguinte. Fonte: [arXiv 2006.10204 §2.1](https://arxiv.org/abs/2006.10204).

O guia oficial de classificação de poses recomenda EMA para ruído frame-a-frame e histerese de limiar duplo para evitar oscilação em volta do threshold. O exemplo oficial usa janela EMA e só reseta quando o stream fica sem input por mais de 100 ms — não quando um frame individual é ruim. Fontes: [pose_classification.md pinado](https://github.com/google-ai-edge/mediapipe/blob/3eb8983cde1517fdff4abbfb33586316af6d45be/docs/solutions/pose_classification.md); [EMASmoothing.java](https://github.com/googlesamples/mlkit/blob/master/android/vision-quickstart/app/src/main/java/com/google/mlkit/vision/demo/java/posedetector/classification/EMASmoothing.java).

`docs/autocalibracao-tolerancia-perda.md` já tinha chegado à mesma conclusão para perda de tracking: abortar a janela inteira ao primeiro `lost` não tem respaldo nas fontes primárias; cobertura + mediana + histerese é o padrão.

### 3.2 Mediana já é um mecanismo robusto contra minoria de frames contaminados

Em estatística robusta, a mediana amostral tem breakdown point de 50%: é preciso contaminar metade das observações para arrastar a estimativa arbitrariamente. Fonte: [Rousseeuw, Tutorial on Robust Statistics](https://wis.kuleuven.be/statdatascience/robust/papers/publications-1991/rousseeuw-tutorialrobuststatistics-jchemtrx-1991.pdf).

Isso não quer dizer que movimento não importa. Se a maior parte da janela for agachamento, inclinação ou braços em posição errada, a mediana vai estimar a postura errada. Quer dizer que **uma mexida curta, alguns frames de oclusão ou jitter não exigem descartar a janela inteira**. A política correta é rejeitar frames/segmentos ruins e exigir cobertura suficiente de frames bons.

### 3.3 Detecção de repouso clássica é dispersão + duração, não distância eterna de uma âncora

O algoritmo I-DT classifica fixação quando amostras permanecem dentro de uma dispersão espacial por uma duração mínima; durações típicas são 100–200 ms no domínio de eye tracking. O ponto transferível não é o número, é a forma: quietude é uma propriedade de uma **janela**, não uma distância permanente ao primeiro frame. Fontes: [revisão de algoritmos de eventos oculares, PMC9699548](https://pmc.ncbi.nlm.nih.gov/articles/PMC9699548/); [Salvucci & Goldberg 2000](https://www.cs.drexel.edu/~dds26/publications/Salvucci-ETRA00.pdf).

Na calibração atual, a âncora absoluta é simples, mas cria o efeito “qualquer mexida reinicia”. Uma janela rolante pode aceitar micro-ajustes naturais e descartar apenas trechos cuja dispersão/velocidade/postura não servem.

### 3.4 Biomecânica de salto também usa baseline de quiet standing com tolerância, não imobilidade absoluta

Em protocolo de countermovement jump com force plate, o peso corporal é a média de 1 s de quiet standing e o início do movimento é detectado quando o sinal sai da faixa de ±5 SD. Fonte: [Owen et al. 2014, PubMed 24276298](https://pubmed.ncbi.nlm.nih.gov/24276298/).

A analogia é limitada — força não é pose de webcam — mas a forma é relevante: “quiet” é operacionalizado por distribuição de ruído e desvio do baseline, não por zero movimento físico. O objetivo é estimar um estado neutro estável, não proibir sway fisiológico.

### 3.5 Motion blur não impede micro-movimento; movimento grande é outro regime

`docs/pesquisa-exposicao-minima-calibracao.md` já conclui que sway em mm/s não borra de forma relevante nem a 1/30 s; os problemas principais em baixa luz são ruído, hunting de exposição, queda de fps e flicker. O mesmo documento observa que membros a 1–3 m/s no gameplay borram dezenas de milímetros.

**Implicação**: permitir sway/postura natural na calibração não entra no regime de motion blur que quebra a medida. Permitir gestos grandes ou corrida durante a coleta é diferente — não porque o reset é obrigatório, mas porque esses frames não representam postura neutra e podem ter blur/confiança piores.

---

## 4. Análise técnica — decompondo o que realmente depende de calibração

O perfil atual tem quatro saídas em `world`:

| Saída | Consumidor | Depende de postura neutra? | Depende de corpo parado? | Observação |
|---|---|---:|---:|---|
| `shoulderWidth` | normalização de velocidade/posição do swing | Pouco | Não, em primeira ordem | É antropometria do torso; qualquer frame torso-confiante contribui. Translação não importa. |
| `leanUp0` | referência vertical da raia | Sim | Precisa de frames neutros/eretos, não imobilidade absoluta | Pode vir de pernas estendidas ou do tronco; frames de inclinação/corrida devem ser excluídos. |
| `torsoLeanRad0` | inclinação lateral neutra da raia | Sim | Precisa de frames neutros/eretos | Natural sway em torno do neutro pode ser medianado; inclinação sustentada não é neutra. |
| `readyWristLocal` | re-arm do swing | Sim, por mão | Só a mão relevante precisa estar em repouso | Não é necessário para o onset; há fallback possível por velocidade baixa. |

A consequência é importante: **“ficar parado” é um proxy grosseiro para “observar postura neutra suficiente”**. O proxy é simples, mas mistura coisas independentes:

- translação do corpo não muda `shoulderWidth` nem as coordenadas body-local;
- mexer um pé não muda a posição neutra dos punhos;
- mexer um punho não muda a vertical neutra do torso;
- movimento de pernas só importa se as pernas estiverem sendo usadas para `leanUp0`;
- ausência/aparição de landmark é evento de visibilidade, não necessariamente movimento corporal.

Portanto, uma máquina de calibração tecnicamente melhor não pergunta “o corpo inteiro ficou imóvel desde a âncora?”. Ela pergunta, por característica:

1. há cobertura temporal suficiente de frames confiantes?
2. os frames pertencem à postura neutra instruída?
3. a dispersão/resíduo da estimativa convergiu?
4. há evidência de mudança de pessoa/câmera que invalide o perfil?

---

## 5. Por que a experiência ainda parece “pedir tudo” apesar do PR de torso

As causas prováveis, em ordem de confiança:

1. **Bloqueio global antes do perfil.** Mesmo os canais calibration-free não emitem eventos enquanto `profileRef.current` é `undefined`. Para o usuário, “sem calibrar totalmente” parece “não vai pro game” porque de fato o pipeline CV não produz controles.
2. **Reset por movimento é global e acumulativo.** Uma mexida descarta as amostras do `Calibrator` e zera o progresso. Não há feedback diferenciando “mexeu demais”, “faltou quadril”, “faltou rosto”, “faltou mão” ou “tracking oscilou”.
3. **Pernas opcionais participam do detector de movimento.** Em corrida, joelhos/tornozelos `[25..28]` podem reancorar a tentativa apesar de não serem exigidos; pior, aparecerem depois da âncora conta como movimento. Isso é especialmente ruim perto da borda inferior do frame, onde esses pontos entram/saem.
4. **Tênis exige ambos os punhos e recalibra tudo ao trocar de modalidade.** Um perfil de corrida descarta referências incidentais de punho; ao entrar no tênis, `App.tsx` chama `recalibrate()` se não houver `readyWristLocal`, recomeçando a cerimônia inteira.
5. **README desatualizado.** O usuário pode estar tentando enquadrar corpo inteiro porque a documentação manda. O PiP está correto, mas é menor e aparece depois.
6. **Versão testada pode não ser o `main` atual.** Nesta sessão o `main` local estava 35 commits atrás antes da atualização; se a experiência observada foi num deploy anterior ao PR #22, ela realmente era full-body. Isso não explica tudo — os problemas 1–4 permanecem no `main` — mas é importante separar versão antiga de design atual.
7. **Condições reais de câmera.** Luz baixa, hunting de exposição, rosto pequeno/inclinado e quadril na borda podem manter a confiança abaixo do gate. O model card explicita degradação com luz/ruído/movimento/overlap.

---

## 6. Direção de implementação recomendada

### 6.1 Mudanças pequenas, alto retorno

1. **Desbloquear corrida/salto sem perfil.** `ActionPipeline` deve processar torso/cadência/jump mesmo com `calibration === undefined`. Raia só roda quando `leanUp0` existir; swings só quando houver referência ou fallback. Isso elimina a sensação de tela de cerimônia sem reduzir a segurança dos canais que realmente dependem de referência.
2. **Separar movimento por consumidor.** Corrida não deve monitorar `[25..28]` para reset a menos que a fonte de vertical por pernas esteja explicitamente ativa. Aparição/desaparecimento de landmark opcional não deve ser tratada como movimento; deve afetar cobertura/qualidade daquela característica.
3. **Trocar reset total por invalidação seletiva.** Frames em movimento não entram na mediana neutra; o relógio/cobertura continua. Se houver mudança sustentada de postura ou blackout longo, reancorar uma janela rolante — não descartar todo o estado já convergido de outras características.
4. **Calibrar punhos por mão.** `readyWristLocal` deveria poder ter `left` e `right` independentes. O pipeline já escolhe qualquer braço; uma mão ausente não deve bloquear a outra. Isso também é um ganho de acessibilidade.
5. **Criar fallback de re-arm por velocidade baixa.** Como `readyWristLocal` só serve para retornar ao repouso, o detector pode rearmar após velocidade baixa sustentada por mais tempo mesmo fora da posição calibrada. Isso reduz a necessidade de calibrar punho e evita deadlock se o jogador descansa o braço em posição diferente.
6. **Explicar o bloqueio real na UI.** Em vez de uma barra que volta sem motivo, mostrar algo como: “faltou quadril”, “cabeça fora do quadro”, “mão direita não visível”, “tracking oscilou — continue assim”, “postura mudou; estamos usando o novo trecho estável”.
7. **Corrigir README.** Trocar a instrução de corpo inteiro por cabeça+ombros+quadril; tênis: incluir a mão da raquete.

### 6.2 Redesign: calibração contínua e progressiva

Em vez de um ritual único de 2–4 s, manter um estimador contínuo com janela rolante curta e estado por característica:

- **escala corporal (`shoulderWidth`)**: mediana/MAD contínua de frames torso-confiantes; converge rápido; atualiza devagar e com limites para não absorver mudanças de pessoa sem invalidação;
- **vertical neutra (`leanUp0`)**: coletar frames com torso ereto, baixa velocidade angular e baixa dispersão; usar pernas somente quando verificadas como estendidas e consistentes, sem trocar de fonte no meio de uma tentativa;
- **inclinação neutra (`torsoLeanRad0`)**: mediana dos frames classificados como neutros; exigir convergência por dispersão, não imobilidade absoluta;
- **repouso de punho**: clustering por mão em frames de baixa velocidade, independente do outro lado; se não convergir, swing pode operar com re-arm por velocidade e posição adaptativa;
- **publicação progressiva**: cada controle recebe um estado próprio — `ready`, `degraded`, `uncalibrated` — em vez de um perfil global tudo-ou-nada.

A forma de stillness deve ser tipo I-DT: uma janela mínima cuja dispersão/velocidade é baixa. A mediana/MAD dá robustez contra minoria contaminada; a janela rolante esquece postura antiga sem apagar todo o aprendizado.

### 6.3 Política de transição de fonte de vertical

O caso dos tornozelos merece decisão explícita. Opções:

1. **Fonte fixa por tentativa**: se a tentativa começou torso-only, termina torso-only; pernas aparecendo não reancoram nem trocam a referência. Simples e evita resets.
2. **Duas estimativas paralelas**: manter `leanUp0` por tronco e por pernas; publicar a por pernas apenas se convergir e discordar dentro de um orçamento, senão manter tronco.
3. **Re-calibração incremental posterior**: depois do jogo começar, se pernas ficarem visíveis e estáveis, melhorar a referência em background com transição limitada.

A opção 1 é a mais simples para o próximo PR; a 2 é melhor arquitetura de médio prazo.

---

## 7. O que precisa ser validado antes de afrouxar os números

As fontes sustentam remover corpo inteiro e reset global, mas não fornecem limiares finais para esta webcam/modelo. Medir em gravações reais:

1. jitter de repouso de `[11,12,23,24]` em image/world, em lux baixo/médio/alto;
2. taxa de visibilidade/presence de quadris e ombros em enquadramento cabeça-até-quadril;
3. tempo até convergir e número de resets por tentativa nas versões atual/proposta;
4. erro de `leanUp0`/`torsoLeanRad0` comparando tronco-only vs pernas-verificadas;
5. erro de `readyWristLocal` por mão e taxa de re-arm com fallback por velocidade;
6. efeito de movimento natural controlado: sway, ajuste de pé, mexer braço, dar um passo lateral, coçar o rosto;
7. comportamento com uma só mão visível e com enquadramento cortando joelhos/tornozelos intermitentemente;
8. taxa de falsos inputs quando a baseline adaptativa é usada desde o primeiro frame.

Os testes sintéticos devem cobrir a lógica (não resetar por perna opcional, ativar corrida sem perfil, uma mão calibrada), mas não substituem essas medições.

---

## 8. Lacunas nas fontes

- Não encontrei validação quantitativa do Pose Landmarker Lite em webcam comum para **enquadramento parcial cabeça–quadril** comparado a corpo inteiro.
- Não encontrei número confiável de jitter de repouso por landmark para Pose Landmarker Lite; os estudos disponíveis medem acurácia contra mocap, não ruído frame-a-frame nessa configuração.
- O estudo PMC13766164 é multi-câmera/triangulação; usar 0,7 como threshold neste app é inspiração, não transferência direta.
- A frase do model card sobre membros ausentes/próteses é qualitativa; não há métrica de erro nem semântica garantida dos scores nesse caso.
- Não há estudo primário encontrado dizendo exatamente como fazer calibração contínua de pose neutra para exergame monocular; a proposta aqui é inferência de engenharia a partir de robust statistics, detecção de quiet standing e contrato do pose tracker.

---

## 9. Resposta final à pergunta

**Tecnicamente, não precisa de tudo isso.** Corpo inteiro não é necessário; rosto+ombros+quadris é o mínimo suportado para o core, e pernas/pés devem ser opcionais. Tênis pode funcionar com uma mão e, em boa parte, sem referência rígida de repouso se o re-arm for adaptativo.

**Também não precisa reiniciar tudo a qualquer mexida.** É preciso impedir que frames que não representam postura neutra contaminem referências posturais. Isso se faz com seleção de frames, janelas rolantes, cobertura, dispersão, mediana/MAD e estados independentes por característica — não com reset global.

**A calibração como cerimônia bloqueante pode ser eliminada para corrida/salto hoje**, porque esses detectores já são auto-referenciados. Para raia e tênis, o correto é ativação progressiva com feedback e fallback, mantendo uma coleta curta explícita apenas como caminho rápido de convergência — não como portão absoluto.

---

## Fontes principais

- [BlazePose: On-device Real-time Body Pose tracking — arXiv 2006.10204](https://arxiv.org/abs/2006.10204)
- [Model Card BlazePose GHUM 3D](https://developers.google.com/static/ml-kit/images/vision/pose-detection/pose_model_card.pdf)
- [MediaPipe issue #1995 — upper-body-only cases no modelo full-body](https://github.com/google-ai-edge/mediapipe/issues/1995)
- [ML Kit Pose Detection](https://developers.google.com/ml-kit/vision/pose-detection)
- [Pose Landmarker — Google AI Edge](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker)
- [Chen et al., validação MediaPipe/Vicon — PMC13766164](https://pmc.ncbi.nlm.nih.gov/articles/PMC13766164/)
- [Pose classification guide pinado — EMA + histerese](https://github.com/google-ai-edge/mediapipe/blob/3eb8983cde1517fdff4abbfb33586316af6d45be/docs/solutions/pose_classification.md)
- [EMASmoothing.java — implementação oficial de exemplo](https://github.com/googlesamples/mlkit/blob/master/android/vision-quickstart/app/src/main/java/com/google/mlkit/vision/demo/java/posedetector/classification/EMASmoothing.java)
- [Revisão I-DT/I-VT — PMC9699548](https://pmc.ncbi.nlm.nih.gov/articles/PMC9699548/)
- [Salvucci & Goldberg 2000 — Identifying Fixations and Saccades](https://www.cs.drexel.edu/~dds26/publications/Salvucci-ETRA00.pdf)
- [Rousseeuw — Tutorial on Robust Statistics](https://wis.kuleuven.be/statdatascience/robust/papers/publications-1991/rousseeuw-tutorialrobuststatistics-jchemtrx-1991.pdf)
- [Owen et al. 2014 — quiet standing baseline em CMJ](https://pubmed.ncbi.nlm.nih.gov/24276298/)

## Fontes internas relacionadas

- `docs/pesquisa-deteccao-pelo-torso.md` — prova de viabilidade torso-only para corrida/salto.
- `docs/pesquisa-exposicao-minima-calibracao.md` — limites de luz/exposição e natureza não validada do piso de 1,8 s.
- `docs/autocalibracao-tolerancia-perda.md` — por que perda transitória deve contar como cobertura, não reset imediato.
- `docs/pesquisa-robustez-gestos.md` — re-arm de salto/swing sob jitter e fallback de repouso por velocidade.
- `src/cv/calibrator.ts`, `src/cv/autoCalibrator.ts`, `src/kinematics/actionPipeline.ts`, `src/kinematics/swingDetector.ts`, `tests/kinematics.test.ts` — estado do código lido para esta análise.
