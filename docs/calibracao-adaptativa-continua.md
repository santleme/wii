# Calibração adaptativa contínua — implicit calibration durante o jogo

Data: 25 de novembro de 2026. Complementa `docs/pesquisa-calibracao-corpo-parcial.md`.

## Pergunta

A calibração precisa ser uma cerimônia visível — “fique parado, mostre o corpo inteiro, espere” — ou o sistema pode estimar e melhorar suas referências enquanto a pessoa simplesmente joga?

## Veredicto

Pode ser contínua e invisível. A literatura de motion capture chama isso de **calibração implícita**, **online calibration** ou **self-calibration during dynamic activity**. Exemplos próximos:

- JointTracker usa estimador Bayesiano recursivo para calibrar cadeias humanas durante movimento, sem pose estática inicial;
- trabalhos recentes de IMU descrevem “implicit calibration”: uso imediato, com estimativa online a partir de restrições observadas numa janela curta e diversificada;
- técnicas clássicas de rastreamento usam mediana/MAD, consenso temporal, estimadores recursivos e seleção de amostras por incerteza.

A implementação atual do app segue essa família, mas permanece deliberadamente simples: **não é um filtro de Kalman completo nem uma posterior Bayesiana formal**. É um estimador online robusto, com priors leves e atualização lenta.

## Algoritmo implementado

### 1. Evidência por frame, não modo de calibração

`src/cv/adaptiveCalibrator.ts` consome os mesmos frames de gameplay. Um frame só vira evidência central quando:

- ombros `[11,12]` e quadris `[23,24]` existem em imagem e mundo;
- confiança mínima é pelo menos `0.55`;
- a geometria não é degenerada;
- intervalos longos sem callback não contam como tempo observado.

Pernas, pés e punhos não são requisitos para essa evidência central.

### 2. Largura dos ombros — mediana robusta rolante

`shoulderWidth` é quase constante para a mesma pessoa. A estimativa usa mediana sobre uma janela rolante de 8 s e uma atualização publicada lenta. Isso evita dois problemas:

- ruído frame a frame não vira velocidade fantasma no swing;
- uma mudança breve de distância/câmera ou poucos outliers não reescrevem a escala.

A prontidão da escala (`readiness.scale01`) combina span observado, cobertura temporal e dispersão da mediana.

### 3. Vertical neutra — consenso temporal tipo RANSAC

`leanUp0` vem de pernas estendidas verificadas quando há evidência suficiente; caso contrário, usa a direção do tronco. Em vez de média, usa consenso vetorial temporal:

1. cada vetor candidato pontua pelo peso dos vetores que concordam com ele dentro de 15°;
2. o grupo dominante vence;
3. a referência é a combinação normalizada desse grupo.

É uma forma simples de consenso tipo RANSAC/mode: inclinações transitórias e frames ruidosos não puxam a vertical como puxariam uma média.

### 4. Inclinação neutra — moda de histograma com priors fracos

`torsoLeanRad0` é estimado por uma moda de histograma seguida de mediana local. Dois priors fracos protegem contra feedback de controle:

- prior de postura ereta: inclinações grandes são menos prováveis de ser neutras;
- prior do posterior atual: desviar da referência publicada não recentra imediatamente o neutro.

Esses priors não impedem adaptação. Uma postura nova sustentada e recorrente ainda acumula evidência e move a referência lentamente. Essa lentidão é intencional: sem ela, segurar uma inclinação para controlar a raia recentraria o neutro e criaria drift circular — o jogo pediria inclinação cada vez maior.

A prontidão neutra (`readiness.neutral01`) combina tempo, cobertura, força da moda e dispersão local. Ela converge mais devagar que a escala porque a inclinação lateral também é entrada de controle.

### 5. Repouso dos punhos — clustering espacial recorrente em baixa velocidade

Para cada mão, independentemente:

1. o punho é transformado para coordenadas locais do corpo, normalizadas por `shoulderWidth`;
2. velocidade é calculada nesse mesmo referencial, então balanço do torso não conta como movimento do punho;
3. só frames de baixa velocidade entram como candidatos a repouso;
4. um cluster denso precisa ser recorrente — ao menos dois episódios separados ou uma permanência longa;
5. a referência publicada é a mediana do cluster e muda lentamente.

Uma única pausa curta não vira referência. Isso reduz o risco de tratar o fim de uma raquetada como posição neutra.

### 6. Publicação progressiva por dependência

O perfil deixa de ser tudo-ou-nada:

- corrida/cadência/salto não dependem do perfil;
- swing depende da escala corporal (`scale01`), então pode ativar cedo;
- raia depende da referência neutra (`neutral01`), então ativa depois;
- referência de punho é opcional e por mão; sem ela o swing ainda rearma por baixa velocidade sustentada.

O jogador não vê fases, progresso, diagnóstico ou instrução de calibração.

## Limite fundamental: identificabilidade

Não existe algoritmo que distingua perfeitamente estas duas situações usando só uma câmera monocular:

1. a pessoa mudou mesmo sua postura neutra;
2. a pessoa está segurando uma inclinação por muito tempo como entrada de controle.

Por isso a solução não promete adaptação instantânea e perfeita. A proteção correta é uma combinação de:

- prior de estabilidade;
- adaptação lenta;
- evidência recorrente;
- histerese;
- janelas rolantes;
- prontidão separada por controle.

Esse é o trade-off inerente de calibração implícita. A versão implementada escolhe não sacrificar a estabilidade do controle para adaptar rápido demais.

## Testes atuais

`tests/adaptiveCalibration.test.ts` cobre:

- publicação torso-only em menos de 1 s sem pernas/punhos;
- não publicar antes de span/cobertura mínimos;
- gaps longos sem callback não contarem como evidência;
- mediana robusta da largura dos ombros;
- preferência por vertical de pernas estendidas e fallback para tronco;
- rejeição de core oculto/confiança NaN;
- adaptação lenta de postura neutra;
- não recentrar depois de inclinação curta estilo raia;
- ativação de swing antes da referência neutra de raia;
- não aprender repouso de punho por uma única pausa curta;
- aprender repouso por recorrência.

## Validação que ainda falta

Os testes sintéticos provam lógica, não ergonomia real. Antes de ajustar números, medir com webcam real/replay:

- jitter p95 de ombros/quadril e punhos em luz normal/baixa/contraluz;
- tempo até `scale01` e `neutral01` cruzarem os limiares;
- frequência de falsos lane/swing durante os primeiros 10 s;
- drift de neutro ao segurar inclinações de raia por 1 s, 3 s e 10 s;
- convergência das referências de punho durante rallies reais;
- comparação CPU/GPU e 30/60 fps.

## Fontes externas consultadas

- [JointTracker: recursive online calibration/tracking for human kinematic chains](https://pmc.ncbi.nlm.nih.gov/articles/PMC11216284/)
- [Transformer IMU Calibrator — dynamic/implicit calibration during activity](https://arxiv.org/pdf/2506.10580)
- [High-Accuracy Real-Time Whole-Body Human Motion Tracking Based on Constrained Nonlinear Kalman Filtering](https://arxiv.org/abs/1511.04278)

Essas fontes motivam a direção; a implementação aqui é específica para os invariantes e limitações do BlazePose monocular.
