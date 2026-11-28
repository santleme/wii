# Gesto rotacional da mão no Wii Menu

## Resumo

O Wii Menu agora aceita um gesto de rotação da palma para girar a roda de canais. O gesto fica restrito à tela `home` e só é alimentado quando a roda está ativa (`ring === true` e nenhum zoom de abertura em andamento). Telas de título, escolha de jogos, gameplay e pose tracking não consomem o detector.

A implementação tem três fronteiras pequenas:

1. **`RotationalFlickDetector`** (`packages/core/src/intent/rotationalFlickDetector.ts`): detector puro e determinístico sobre `worldLandmarks`.
2. **Arbitragem do cursor de mão** (`src/kinematics/handCursor.ts`): decide quando a rotação bloqueia pinça, punho/voltar e hover.
3. **`CarouselController`** (`src/ui/carouselController.ts`): física contínua da roda em `requestAnimationFrame`, sem simular cliques nas setas e sem renderizar React a 60 fps.

## Fluxo

```text
HandLandmarker worldLandmarks (21 x 3D)
        │
        ▼
palmBasis(WRIST, INDEX_MCP, MIDDLE_MCP, PINKY_MCP)
        │  base 3D no espaço da câmera
        ▼
rotação relativa entre frames / dt real ──► velocidade angular bruta
        │                                      │
        │                              OneEuroFilter (escalar)
        │                                      ▼
        └──────── curvatura dos dedos ──► palma aberta / concha / desconhecida
                                               │
                                               ▼
                              IDLE → ROTATION_CANDIDATE → ROTATING
                                                ⇅             ⇅
                                             CANCELLED     RECOVERY
                                                               │
                                                     palma aberta ▼
                                                     BRAKING → SNAP_TO_CARD → IDLE
```

A base da palma preserva a rotação global da mão no espaço da câmera. Isso é diferente de `canonicalLandmarks`, que remove rotação e escala para reconhecimento de forma. O detector mede o menor giro relativo entre bases 3D, portanto não existe salto de `359° ↔ 0°` e nenhum ângulo absoluto com wrap-around é filtrado.

## Contrato de ativação

`App.tsx` passa para o `HandCursorDetector`:

- `worldLandmarks` da mão primária;
- `rotationEnabled` somente quando a tela atual é `home` **e** `HomeMenu` marcou a roda como ativa.

`HomeMenu` é o dono do gate porque só ele sabe se a grade já virou roda e se o zoom de abertura não começou. Ao sair da tela, entrar em zoom ou desmontar o componente, o gate volta para `false`. A troca de tela/câmera, portanto, cancela a rotação em vez de deixar velocidade ou gestos armados.

## Estados e arbitragem

- `ROTATION_CANDIDATE`: 110 ms de evidência antes de assumir controle. Ainda não bloqueia nada: pinça, voltar e swipe seguem ativos, e uma pinça em andamento desliga a rotação.
- `ROTATING`: a velocidade angular arbitrada alimenta o carrossel; hover, clique, voltar e swipe ficam bloqueados.
- `RECOVERY`: o retorno passivo da mão mantém momentum; pequenas velocidades contrárias são zeradas. Uma reversão exige impulso acima de limiar maior com histerese.
- `BRAKING`: palma aberta sustentada por 70 ms; a velocidade de controle vai a zero e o carrossel desacelera imediatamente.
- `SNAP_TO_CARD`: o canal mais próximo (`Math.round(turn)`) vira alvo do snap.
- `CANCELLED`: perda de mão, timestamps inválidos, gap longo ou troca de quiralidade. Ao sair da rotação, pinça e punho precisam ser rearmados (`release`/`open`) antes de clicar ou voltar.

## Parâmetros iniciais

| Parâmetro | Valor | Motivo |
|---|---:|---|
| `candidateMs` | 110 ms | evita que mover a mão ou pinçar vire rotação; o primeiro frame conta no máximo metade |
| `candidateMinSpeedDegPerSec` | 70°/s | acima do giro incidental de quem só move a mão |
| `candidateTimeoutMs` | 240 ms | tolera frame ruidoso de forma/curvatura a 15–20 fps sem manter candidatura indefinida |
| `openBrakeConfirmMs` / `candidateShapeCancelMs` | 70 / 70 ms | histerese contra um frame isolado de dedos abertos ou fechados |
| `maxFrameGapMs` | 250 ms | tolera a cadência de webcams lentas |
| `reversalSpeedDegPerSec` | 95°/s | reversão exige mais energia que a entrada |
| `maxAngularVelocityDegPerSec` | 360°/s | teto de uma volta visual por segundo |
| `brakeSnapDelayMs` | 65 ms | palma aberta precisa persistir brevemente antes do snap |
| `snapSignalMs` | 300 ms | dá tempo de o carrossel completar o snap de 180–250 ms |
| `cuppedMinCurvature` / `openPalmMaxCurvature` | 0.13 / 0.06 | curvatura por cossenos articulares; separa concha de palma aberta com histerese |
| `snapDurationMs` do carrossel | 220 ms | clamped em 180–250 ms |
| `driveResponseMs` / `brakeResponseMs` | 90 / 42 ms | resposta suave ao impulso e frenagem quase imediata |

A curvatura usa `1 - média(cosseno articulado)` em `worldLandmarks`. Métricas de “retidão” por ponta/base quase não separavam palma aberta de punho em medições sintéticas; os cossenos articulares separaram melhor porque capturam a dobra distribuída dos dedos.

## Física da roda

O controlador integra com `deltaTime` real do `requestAnimationFrame`:

- fase `ROTATING`: aproximação exponencial da velocidade desejada;
- `RECOVERY`/mão quieta: momentum decai exponencialmente;
- `BRAKING`: decaimento rápido para zero;
- `SNAP_TO_CARD` ou momentum baixo: snap ease-in-out para o canal inteiro mais próximo;
- `prefers-reduced-motion`: o snap é imediato e a animação orbital do cursor é desligada.

O loop de `requestAnimationFrame` roda enquanto a roda está pronta, com ou sem mão; ocioso, não move nada, e mouse e transições CSS não dependem dele. Amostras de mão mais velhas que 150 ms são tratadas como ociosas, evitando que um frame `ROTATING` parado continue acelerando a roda. Cliques de mouse/setas assumem ownership por 900 ms — a duração da transição CSS — para que um flick no meio da animação não salte do alvo. O componente React continua sendo a interface para mouse/teclado: setas e clique em canais chamam `syncTurn` no controlador e preservam a transição CSS existente. Durante controle por gesto, o controlador escreve `left/top/transform/opacity/zIndex` diretamente nos canais e a classe `is-gesture-controlled` remove as transições que disputariam o mesmo atributo. React é sincronizado somente quando o canal frontal muda ou quando o movimento assenta.

## Swipe lateral

`src/kinematics/handSwipe.ts` avança ou volta um canal com um movimento horizontal rápido (mão para a esquerda avança). Avalia janelas deslizantes de 40–140 ms: exige velocidade média de 1,55 largura de imagem por segundo, deslocamento horizontal líquido de pelo menos 0,1 largura, dominância horizontal (1,25× a vertical) e pelo menos dois intervalos no mesmo sentido, com a mão antes em repouso. Há cooldown de 350 ms no mesmo sentido e 450 ms no oposto. Fica bloqueado durante pinça, punho e rotação comprometida, e a pinça só rearma quando a mão desacelera. Um alcance muito rápido do cursor também pode dispará-lo.

## Diagnóstico opcional

Ative com `?handDebug=1`. O overlay mostra apenas dados reais do pipeline:

- fase, forma da mão e curvatura;
- base 3D (normal da palma e eixo punho→médio);
- velocidade angular bruta, filtrada e arbitrada;
- estado da pinça, motivo de congelamento, movimento de swipe, latência captura→entrega e FPS efetivo do worker;
- direção, motivo de rejeição, `dt` e FPS efetivo da mão;
- modo, velocidade, `turn`, canal frontal, `dt` e FPS efetivo do carrossel.

O overlay é desativado por padrão e usa `pointer-events: none`.

## Cobertura automatizada

Cobertura adicionada/estendida:

- `tests/rotationalFlickDetector.test.ts`: 31 testes determinísticos, incluindo wrap angular, jitter, timestamps inválidos/irregulares, gaps, FPS variados, troca de quiralidade, espelhamento esquerda/direita, mão aberta/fechada, recuperação, reversão, frenagem, snap e cancelamento.
- `tests/carouselController.test.ts`: física independente de FPS, teto de 360°/s, momentum, reversão, frenagem, snap, wrap de canais, `prefers-reduced-motion`, validação de parâmetros e ownership externo.
- `tests/handCursor.test.ts`: 6 cenários novos de arbitragem (gate desligado, publicação de velocidade/fase, supressão e rearme de pinça/punho, cursor congelado e perda de mão).
- `tests/useHandHitTest.test.tsx`: hover/clique/voltar bloqueados durante rotação e clique segurado não disparado atrasado.
- `tests/homeMenuCarousel.test.tsx`: pintura direta contínua, classe de controle, dados de debug e cancelamento de `requestAnimationFrame` no unmount.

## Validação manual com webcam

1. Rode `npm run dev` e abra o Wii Menu com `?handDebug=1`.
2. Ative a câmera e aguarde o estado `synced`.
3. Na roda, curve levemente a palma e gire como se desenrolasse um volante pequeno.
4. Confira no overlay: forma `cupped`, fase `ROTATING`, direção coerente e velocidade de controle abaixo de 360°/s.
5. Retorne a mão sem girar no sentido contrário: a roda deve continuar por momentum curto.
6. Abra a palma: deve entrar `BRAKING`, depois `SNAP_TO_CARD`; a roda deve parar no canal mais próximo.
7. Com a fase em `ROTATING`, aproxime polegar/indicador ou feche o punho: nenhum clique/voltar deve ocorrer. Ao terminar, solte e refaça o gesto de pinça para confirmar o rearme.
8. Inicie um jogo ou desligue a câmera no meio do gesto: a rotação deve cancelar e o gate voltar a falso.

### Calibração

Se a webcam estiver baixa ou a mão muito distante, aumente `candidateMs` ou `candidateMinSpeedDegPerSec`. Se palmas abertas forem classificadas como concha, aumente `cuppedMinCurvature`; se a concha for classificada como aberta, reduza `openPalmMaxCurvature`. Faça mudanças pequenas e revalide com os testes determinísticos antes da webcam.
