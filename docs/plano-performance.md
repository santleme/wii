# Plano de performance — o travamento do boxe

Diagnóstico a partir de duas auditorias profundas (pipeline de pose + render do jogo),
medições das gravações reais e fatos da máquina. Verdade medida:

- Inferência de pose em CPU, modelo **lite** (já é o lite — não há troca fácil),
  mediana **83ms/frame**, p90 148ms → input de pose a **~12-15fps** com engasgos de até 230ms.
- Máquina local: Ryzen 7 7700X (16 threads), **sem GPU** (/dev/dri vazio) — GPU delegate
  aqui é GL de software (96-243ms, já documentado no worker). Sem isolamento cross-origin,
  o wasm roda **single-threaded** apesar de ter pthreads/atomics compilados.
- Câmera pedida a 60fps mas só ~12-15fps viram inferência — **75-85% dos frames capturados
  são decodificados/compositados e descartados** sem nunca virar bitmap.

## Os três mecanismos do travamento

1. **O governor de qualidade nunca foi ligado no boxe** (bug de omissão de uma linha).
   A infraestrutura existe, está testada (`tests/boxingRingScene.test.ts`) e os outros três
   jogos a usam: tier 2 desliga sombras, crowd 360→120, beams off, pixelRatio cai para 1.0/0.75.
   O boxe renderiza SEMPRE na qualidade máxima: 2 spotlights com shadow maps 1024² re-renderizados
   todo frame, 5 luzes + IBL, MSAA, pixelRatio 1.5 fullscreen.
2. **Trabalho de apresentação multiplicado em catch-up**: `poseScene`/`animate` rodam dentro
   de cada fixed step; num frame atrasado de 100ms, 5 steps posam bonecos que nunca serão
   renderizados — exatamente nos piores frames, onde a CPU já está faminta.
3. **A inferência ocupa um núcleo inteiro o tempo todo** (83ms serializado → duty cycle ~100%),
   competindo com render, React e GC. Tudo que alivia CPU amplifica.

## Plano em ordem de alavanca

### P0 — imediato, baixo risco
1. Ligar `loop.onQualityChange` no boxe → degradação adaptativa automática.
2. Câmera `ideal: 60` → `ideal: 30`: metade do trabalho de captura/compositing desperdiçado,
   custo de latência médio +8ms quando o worker libera (inferência é 83ms — irrelevante).

### P1 — estrutural, validado por benchmark
3. **Teste empírico COOP/COEP**: o wasm do tasks-vision tem pthreads/atomics compilados.
   Se com `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`
   o XNNPACK passar a usar threads, a inferência pode cair várias vezes — a maior alavanca
   potencial de todas. Benchmark antes/depois é obrigatório; se não houver ganho, reverter.
4. Posar apenas no último step do frame (acumular dt de animação, aplicar uma vez por render).

### P2 — reduções de custo constante
5. Um spotlight com sombra em vez de dois (a segunda sombra é sutil em arena indoor).
6. `rememberFrame` (buffer de diagnóstico de 20s) gated por flag de diagnóstico em produção.
7. `zoneHistory` sem cópias `[...].reverse()` no hot path.

### Fora de escopo (com justificativa medida)
- Dois workers de pose alternando: dobra CPU, quebra o tracking temporal do landmarker
  (cada instância vê metade dos frames) — rejeitado pela auditoria.
- Resolução de entrada menor: o tensor interno é fixo, ganho pequeno e risco de precisão
  nos punhos — só com benchmark duplo, depois.
- GPU delegate: sem GPU na máquina local; no Windows do usuário é experimento `?delegate=gpu`
  que já existe — GPU+lite nunca foi testado (GPU sempre usa full), fica como experimento separado.

## Critérios de validação
- `npm test && npm run lint && npm run build` verdes.
- Benchmark empírico da inferência (playwright + mediana de `detectForVideo`) antes/depois
  do COOP/COEP.
- Suíte de regressão das gravações de boxe intacta (detectors não podem mudar de comportamento).

## Resultados da implementação (sessão 1)

Implementado e validado (1003 testes verdes, lint limpo, build ok):

1. **Governor ligado no boxe** — uma linha; degradação adaptativa automática de pixelRatio
   (1.5→1.0→0.75), sombras, crowd e beams quando frames ficam lentos. Era a maior alavanca
   disponível: infraestrutura completa e testada que estava desligada só no boxe.
2. **Câmera 60→30fps** — metade do trabalho de captura/decodificação/compositing que era
   descartado sem nunca virar inferência.
3. **Apresentação uma vez por frame** — `poseScene` acumula dt e roda só no último step;
   o smoothing exponencial compõe exatamente, movimento idêntico, sem posing desperdiçado
   em catch-up (até 5x menos trabalho de apresentação nos piores frames).
4. **`findLastEntry` sem cópia** — 4 hot paths de zoneHistory sem `[...].reverse()`.
5. **`rememberFrame` gated por diagnóstico** — buffer de 20s de snapshots não retém mais
   em produção (o consumidor E-key já era gated).
6. **PCFShadowMap explícito** — o tipo PCFSoft foi removido no three 0.187; o warning
   parou de poluir diagnósticos.

### Resultado negativo medido — threading no wasm está morto

A hipótese mais promissora foi testada empiricamente e **rejeitada**: o wasm do
@mediapipe/tasks-vision 1.2.3 tem instruções atômicas e strings pthread compiladas,
mas a cola JS **não spawna workers** (zero `new Worker`/`SharedArrayBuffer` no glue) —
é estritamente single-threaded e COOP/COEP não muda nada. Benchmark com playwright
(com/sem isolamento cross-origin, mesmo workload): 13.8ms vs 13.5ms mediana — dentro
do ruído. Não implementar COOP/COEP para este fim.

### Fatos de hardware medidos

- Esta máquina (Ryzen 7 7700X): inferência pose lite ~14ms/frame — 6x mais rápida que
  a máquina Windows das gravações (83ms mediana). O gargalo do usuário é hardware-dependent.
- Sem GPU nesta máquina (/dev/dri vazio) — GPU delegate aqui é GL de software.
- Espera-se que as mudanças de contenção (P0) beneficiem proporcionalmente mais a
  máquina mais fraca, onde a inferência ocupa o núcleo por 83ms e o governor agora
  degrada o render em vez de travar.

### O que resta medir ao vivo

- `?fps` na máquina do usuário: fps de tela e tier do governor antes/depois.
- Se a máquina Windows tiver GPU: experimento `?delegate=gpu` — mas atenção que GPU
  usa o modelo full (mais caro); GPU+lite nunca foi testado e seria a comparação justa.
