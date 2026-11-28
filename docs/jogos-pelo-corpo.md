# Jogos pelo corpo: Atletismo e Tênis

Data: 27 de novembro de 2026. **Estado: jogável, ainda não testado com outras pessoas.**

O menu tem dois jogos, os dois controlados só pelo corpo, sem teclado nem mouse: **Atletismo**
(100, 200 ou 400 m) e **Tênis**. A corrida com obstáculos continua no código, fora do menu.

> **Ressalva principal.** Todos os limites de detecção foram escolhidos em gravações de **uma única
> pessoa**, na mesma sala e webcam. Na primeira gravação nunca usada em ajuste, a corrida caiu para
> 42% de detecção. Antes de confiar em qualquer número abaixo, é preciso ver outras pessoas jogando.

## 1. O que o jogador faz

1. No menu, escolhe com a **mão** (cursor da mão): Atletismo e a distância, ou Tênis.
2. O jogo prepara a pessoa:
   - **Atletismo:** enquadramento e um aquecimento de 5 s correndo com tudo.
   - **Tênis:** um aquecimento guiado na quadra, sem adversário: raquetadas, o outro lado, lançamento e saque.
3. Joga.
4. No fim, **levanta as duas mãos** por 1,5 s para jogar de novo.

Para voltar ao menu pela tela de resultado, **cruza os antebraços em X** diante do peito por 1,5 s
(`armsCrossed`, em `framing.ts`). No meio de uma partida, ainda é preciso clicar em "‹ Jogos".

## 2. Do quadro da câmera ao jogo

```
webcam ─▶ PoseClient (Worker, MediaPipe Pose Lite na CPU) ─▶ App.onPose
            └─ ActionPipeline (src/kinematics/actionPipeline.ts)
                 ├─ TorsoVerticalChannel: ombros, cabeça e pulsos no mesmo quadro
                 │    ├─ IntensityMeter  ─▶ rawEffort   ─▶ Atletismo
                 │    └─ (obstáculos: corrida, caminhada, pulo, raia)
                 └─ SwingDetector (um por pulso) ─▶ swing ─▶ Tênis
            framingAdvice / handsHidden / handsRaised (src/kinematics/framing.ts) ─▶ os dois jogos
```

- **Visão na CPU por padrão** (`src/cv/delegate.ts`): numa GPU integrada, o modelo Full disputava com o
  jogo 3D e a câmera travava. `?delegate=gpu` volta à GPU com o modelo Full.
- **Só os ombros são obrigatórios** (`torsoVertical.ts`). O quadril costuma ficar fora de uma webcam de
  notebook ou atrás dos braços. Tudo é medido em **larguras de ombro**, o que cancela a distância.
- **Quadros quebrados são descartados:** em movimento rápido o rastreador às vezes cola um ombro no
  outro (largura de 0,28 para 0,01). Esqueleto de cabeça para baixo também é descartado.
- **O detector precisa ver a cabeça:** o BlazePose acha a pessoa pelo rosto
  ([artigo](https://arxiv.org/abs/2006.10204)). Com a cabeça cortada, perdia-se o corpo na corrida.

## 3. Atletismo

Estádio de 400 m, Mii, abertura e câmera de perseguição vêm do PR 41 (GUZZBR1). As regras são de
`src/games/athletics/race.ts` (puras, testadas em `tests/race.test.ts`); a cena é `AthleticsGame.ts`.

| Fase | O que acontece |
| --- | --- |
| Enquadramento | Pede para inclinar a câmera, afastar, chegar perto ou centralizar. Segue com 1 s de imagem boa, ou após 15 s com o corpo visível. |
| Aquecimento | 5 s "corra com tudo". O Mii corre no lugar. A barra enche quando o sinal atinge o mínimo para calibrar. A calibração exige 1,5 s de sinal válido entre quadros recentes nos últimos 3 s. Um valor alto desse intervalo define a referência daquela pessoa e câmera. Se quase nada for lido, repete até duas vezes dizendo "mostre as mãos" ou "mexa mais os braços"; depois usa um padrão. |
| Contagem | 3, 2, 1 com som. |
| Prova | Três rivais (Bia, Caio, Davi) de ritmo fixo, um pouco mais lento nas distâncias maiores. Parcial com som a cada 100 m. |
| Chegada | Colocação, tempos de todos, recorde pessoal por distância (no navegador). |

**Velocidade:** a intensidade dividida pelo percentil 80 das leituras dos últimos 3 s do aquecimento, com 15% de folga. Igualar o
aquecimento dá cerca de 7,4 m/s (100 m em uns 14 s); passar dele ainda rende. Ganha velocidade em
0,5 s e perde em 1,4 s, então uma leitura falha custa pouco.

**Câmera congelada:** uma leitura com mais de 0,5 s não vale; o boneco desacelera em vez de seguir
correndo com o último valor.

### Medidor de intensidade (`src/kinematics/intensity.ts`)

Uma medida só: **o quanto a pessoa se move por segundo**. Soma a velocidade vertical dos pulsos (em
relação aos ombros) e a da cabeça, em larguras de ombro. Cresce com o ritmo **e** com o tamanho do
movimento. Se cabeça e ombros se movem na mesma direção, o balanço comum também conta, inclusive
quando o movimento dos braços é pequeno ou os pulsos saem do quadro.

Nas gravações, em larguras de ombro por segundo: parado 0,02–0,3; andando até 0,7; correndo 1,2–2,8.

Substituiu duas versões medidas e descartadas:
- balanço da cabeça, que ignorava quem trota "deslizando" (0,1–0,35 correndo);
- contagem de alternâncias dos pulsos, que travava em 100% num bombeio forte e ignorava braços curtos.

Limitações: mexer só os braços rende velocidade (aceito nesta prova); andar rende pouco; o ângulo da
câmera muda o valor bruto, compensado pelo aquecimento.

## 4. Tênis

Regras e decisões de jogo estão em [design-tenis.md](design-tenis.md): o Mii corre sozinho até a bola,
a direção sai do **momento** da raquetada (cedo cruza, tarde vai reto) e o contato é julgado no instante
físico do golpe, não quando o evento chega.

Neste estado:
- quadra com áreas de saque e segundo saque, placar de games e pontos, melhor de 3 games;
- abre com um **aquecimento na quadra** (`tutorial.ts`): 3 raquetadas, 2 do outro lado, 2 lançamentos e 2
  saques. Cada um avança quando é reconhecido; sem progresso, explica aos 10 s e segue aos 22 s; as duas
  mãos levantadas pulam. Ele aprende a **mão da raquete** e o **tamanho do golpe** da pessoa (entre 1,6 e
  1,9 largura de ombro, nunca mais rígido que o padrão). Só no primeiro jogo; "jogar de novo" vai direto;
- estádio de grama com arquibancadas, torcida e árvores (`stadium.ts`), e câmera baixa atrás do jogador;
- tenistas no estilo Mii, com mãos soltas e raquete grande (`athlete.ts`);
- janela de acerto generosa (±0,5 s) e bola lenta, com um **anel no chão que fecha** quando é hora de bater;
- golpe com arco e rastro, clarão e tremida no impacto, som de raquete, torcida que pula e aplaude e placar
  falado pelo navegador (`effects.ts`, `audio.ts`);
- **o saque não se erra**: qualquer raquetada durante o lançamento entra na área certa; o momento só muda
  força e ângulo;
- forehand e backhand **aparecem diferentes**: o boneco fica ao lado da bola e recua a raquete para o lado
  dela, o golpe sai do lado reconhecido, o rastro é amarelo (forehand) ou azul (backhand) e o nome aparece;
- **saque em dois gestos**: levantar a **mão livre** lança a bola na hora, e a raquete saca. A mão da
  raquete é aprendida nas rebatidas (destro até prova em contrário) e nunca lança. A bola espera 2,6 s.
  Medido numa gravação: o lançamento natural dura de 0,4 a 0,7 s, curto demais para exigir mão parada.
- a **altura** em que o golpe termina muda a bola: acima da cabeça sai alta, abaixo do peito sai rasante;
- um quadro borrado no meio do golpe é pulado. Antes ele apagava o golpe, e a volta do braço era lida
  como backhand;
- o adversário **devolve sempre as 3 primeiras bolas** do ponto; depois pode errar, mais sob pressão, e
  fica visivelmente longe da bola quando erra;
- `?fps` mostra o atraso entre a captura do quadro e a chegada ao jogo;
- a altura final é **prevista** pela velocidade com que o braço sobe, sem esperar o braço chegar.
  Antecipar a animação foi medido e descartado: ganhava uns 60 ms e criava 41 movimentos falsos para 63
  golpes;
- **ajuda de último instante** (`armMotion.ts`): se nenhum golpe foi lido e a bola está passando,
  qualquer movimento claro do braço (1 largura de ombro em 0,5 s) devolve, fraco e no meio. Veio da
  gravação de uma segunda pessoa, vista pela câmera em 727 de 742 quadros e com **um** golpe lido: essa pessoa bate mais
  devagar, mais para cima e menos de lado. Um golpe reconhecido sempre vem antes e é o que dá força e direção;
- reinício pelas mãos.

### Detector de raquetada (`src/kinematics/swingDetector.ts`)

Um golpe é o pulso **percorrer muito em pouco tempo**: 1,9 largura de ombro em 270 ms, de lado ou de
lado e subindo (pelo menos 0,8 de lado), medido na imagem em relação ao meio dos ombros. A largura usada
como régua só diminui devagar, porque o tronco girando faz os ombros "encolherem". Descer o braço não
conta, e a volta no sentido contrário é ignorada por 0,8 s.

Medido em duas gravações de uma pessoa:
- **golpes exagerados:** os 12 visíveis são lidos, mais uma leitura com o pulso saindo do quadro;
- **golpes compactos, jogando:** 5 de 8 visíveis (um dos perdidos vem antes de a calibração ficar pronta).
  A regra anterior não lia nenhum.

Quem bate mais curto ou devagar ainda pode não ser reconhecido.

## 5. Peças compartilhadas

| Peça | Arquivo |
| --- | --- |
| Enquadramento e mãos visíveis/levantadas | `src/kinematics/framing.ts` |
| Reinício pelas duas mãos (só depois de baixá-las) | `src/games/core/restartGesture.ts` |
| Aviso de cabeça fora do quadro (após 1,5 s) | `HeadWarning`, em `framing.ts` |
| Resolução que cai se o quadro pesar | `src/games/core/qualityGovernor.ts` (PR 41) |

## 6. Corrida com obstáculos (fora do menu)

Ficou no código, sem manutenção. Os detectores abaixo só servem a ela:

| Ação | Técnica | Arquivo |
| --- | --- | --- |
| Correr | quanto os dois ombros e a cabeça sobem e descem juntos em 1 s | `bounce.ts` |
| Andar | vai e vem lateral dos ombros, um por passo, com a cabeça quase parada | `walk.ts` |
| Pular | ombros e cabeça ≥ 0,45 largura acima de onde estavam; em pulos seguidos, medidos do chão | `jumpDetector.ts` |
| Raia | centro medido quando a pessoa fica 1 s parada | `postureSignals.ts` |

## 7. Como medir (ferramentas de desenvolvimento)

Ficam em `src/cv/diagnostics/` e só ligam em desenvolvimento ou com `?debug`/`?fotos`, para um visitante
não reiniciar nada sem querer.

- **G**: grava um roteiro guiado de pontos do corpo (corrida ou tênis).
- **E**: salva os últimos 20 s depois de um erro.
- `?fotos`: o **E** inclui pequenas imagens da câmera. São imagens da pessoa: não commitar e só
  compartilhar com o consentimento dela.
- `?fps`: taxas de tela, câmera e pose, e o chip que desenha o WebGL.
- Gravações em `tests/recordings/` e trechos em `tests/recordings/errors/` (ignorados pelo git).
  `tests/recordedTrack.test.ts` falha se uma gravação piorar; **sem as gravações locais, nada disso
  roda**, inclusive no CI.
- `scripts/pose-replay.html` gera o mesmo formato a partir de um vídeo, a 30 quadros por segundo.

## 8. Outras ressalvas

- A confiança mínima do modelo caiu de 0,5 para 0,38 sem comparação isolada.
- A calibração contínua ainda calcula um centro de raia que nenhum dos dois jogos usa.

## 9. Falta fazer

1. Uma prova e uma partida completas na câmera, sem tocar no computador.
2. Mais gravações de tênis (outra pessoa, golpes suaves, canhoto).
3. Pelo menos três outras pessoas, com critério definido antes: a barra enche correndo, fica vazia
   parado, correr forte é claramente mais rápido que correr leve, e as rebatidas são reconhecidas.
4. Sair de uma partida em andamento sem mouse.
5. Ajustar o ritmo dos rivais e a escala de velocidade, hoje um primeiro chute.
6. Diagnosticar travamentos de câmera com `?fps`.
7. Opcional: avaliar em [UTD-MHAD](https://personal.utdallas.edu/~kehtar/UTD-MHAD.html) (8 pessoas
   correndo no lugar; câmera e distância diferentes; a página não declara licença).
