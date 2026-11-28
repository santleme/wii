# Progresso da refatoração arquitetural

Este é o registro vivo das rodadas de melhoria arquitetural solicitadas para o produto. O trabalho preserva o comportamento e os contratos existentes, migra os chamadores no mesmo lote e remove a implementação substituída quando a compatibilidade permite.

## Estado da iniciativa

- **Base atual da branch:** `origin/main` em `241a8c3`, com PR42 (#42), boxe (#44), rotação do menu (#46) e polimento do menu (#47) já integrados; trabalho na worktree isolada `refactor/canonical-frame-capture`.
- **Levantamento do estado ativo:** PR42 e worktrees/orquestrações locais foram comparados; mudanças locais não revisadas foram preservadas e não copiadas.
- **Estado do checkout compartilhado:** alterações locais fora desta worktree são preservadas e não fazem parte desta rodada.
- **Skills aplicadas:** `codebase-design` e `domain-modeling`.
- **Glossário/ADRs anteriores:** não existem nesta base. Criar o glossário quando um termo de domínio precisar ser resolvido; registrar decisões arquiteturais com trade-offs duradouros em `docs/adr/`.

## Mapa de arquitetura — base `origin/main`

### Fluxo principal

```mermaid
flowchart LR
  Browser[Browser: webcam, storage, DOM] --> Site[src/main.tsx + src/app/App.tsx]
  Site --> ArenaShell[src/components/ArenaShell.tsx]
  ArenaShell --> Arena[src/App.tsx: camera and game orchestration]
  Arena --> AppAdapters[src/cv: local assets and browser adapters]
  AppAdapters --> Core[@wii/spatial-core]
  Core --> Workers[Pose and hand module Workers]
  Workers --> MediaPipe[Local MediaPipe WASM and task models]
  Core --> Snapshots[PoseSnapshot / HandSnapshot]
  Arena --> Calibration[src/cv/adaptiveCalibrator.ts]
  Snapshots --> Kinematics[src/kinematics: pure detectors]
  Kinematics --> Events[SportActionEvent / ContinuousControls]
  Events --> GameCanvas[src/ui/GameCanvas.tsx]
  GameCanvas --> Games[src/games: Track and Tennis]
  Games[Track, Athletics, Tennis, Boxing] --> Loop[src/games/core/GameLoop.ts]
```

`src/app/App.tsx` is the website router and page shell; `src/App.tsx` is the camera and arena coordinator. The similar names describe separate modules and are an ongoing source of navigation cost.

### Modules and ownership

| State or rule | Current owner | Readers and important constraints |
| --- | --- | --- |
| Camera stream, UI mode, camera attempt and vision activation | `src/App.tsx` | Starts/stops the browser stream and chooses hand or pose capture. `cameraAttemptRef` invalidates physical camera sessions; `visionActivationRef` invalidates detector activations, including hand→pose→hand. |
| Pose worker, request IDs, capture epoch | `packages/core/src/providers/poseClient.ts` | Owns the pose Worker, frame correlation, capture callbacks and pose protocol. `VideoFramePump` owns scheduling and single-flight; the pose bitmap is transferred to the worker. |
| Hand worker, capture and in-flight frame | `packages/core/src/providers/handClient.ts` | Owns the hand Worker, worker request correlation, resizing and live capture. `processFrame` closes rejected bitmaps and transfers accepted ones; the shared pump owns scheduling and single-flight. |
| App hand adapter | `src/cv/handClient.ts` | Supplies versioned local asset URLs and asset warming. It no longer implements a second capture scheduler. |
| Alternate provider switching | `packages/core/src/runtime/spatialRuntime.ts` | Owns a provider generation. It delegates live capture to providers that support it; each processFrame-only hand activation owns a separate pump. It is exported and tested, but no production caller was found. |
| Calibration and action history | `src/App.tsx`, `src/cv/adaptiveCalibrator.ts`, `src/kinematics/*` | The coordinator owns long-lived instances; pure detectors own their local filters and timing windows. `adaptiveCalibrator.ts` consumes kinematics helpers; the reverse type dependency was removed in round 2 by importing contracts from `@wii/spatial-core`. |
| Three.js renderer, fixed-step clock and shared scenery | `src/games/core/GameLoop.ts`, `src/games/core/scenery.ts` | Game instances own their scene objects; shared game primitives live under `games/core` rather than a single sport. |
| Rules and match state | `src/games/track/*`, `src/games/athletics/*`, `src/games/tennis/*`, `src/games/boxing/*` | Pure rules have direct deterministic tests; rendering is owned by each game class. Cross-game imports remain in the backlog for a dedicated ownership pass. |
| Website and menu state | React modules under `src/app`, `src/components`, `src/pages`, `src/ui` | Local UI state stays in React. The language provider owns selected language. |
| Browser persistence | `src/lib/quality.ts`, `src/App.tsx`, `src/i18n.tsx`, `src/components/SiteHeader.tsx`, legacy `TrackGame.ts` | Local storage holds quality preference, mute, language, theme and obstacle-course records. There is no server-side user store. |

### Contracts, infrastructure, and production constraints

- There is no backend API, authentication service, or remote application data store. The product deploys as static Vite assets; browser permission controls camera access.
- Worker messages and `PoseSnapshot`/`HandSnapshot` types live in `packages/core/src/providers/` and `packages/core/src/types.ts`. `src/cv/protocol.ts` is a one-line re-export used by many app modules; it does not define a competing protocol.
- `src/cv/mediapipeAssets.ts` pins local model hashes and the WASM version. App adapters construct versioned local URLs and warm assets. The workers fetch the local model files; video frames stay on-device.
- `vite.config.ts` maps `@wii/spatial-core` to source in app/dev mode. Tests resolve the built workspace package; `pretest` builds it first. This is intentional and verified by the workspace/package setup.
- The browser-facing errors include camera acquisition, worker initialization (30-second timeout), worker errors and GPU-to-CPU fallback. Site article failures are logged at the app error boundary. Developer CV recordings/replays live under `src/cv/diagnostics` and `scripts/`.
- CI (`.github/workflows/ci.yml`) runs `npm ci`, tests, Biome lint, production build and article validation. A scoped Biome override now enforces the purity/import direction of `src/kinematics`; other ownership and dependency rules remain in the backlog.
- There is no shared theme package: site and arena styling have separate CSS entry points. The design system and accessibility contracts remain to be audited before any visual consolidation.

## Rodada 1 — captura de quadros

### Checklist de estado e concorrência

| Item | Decisão/estado observado para a migração |
| --- | --- |
| Donos | `App` continua dono do `MediaStream` e da modalidade. Cada provider continua dono do Worker, dos IDs de requisição e do protocolo. O novo pump é dono apenas do agendamento e do backpressure de captura. `SpatialRuntime` continua dono da geração de provider. |
| Leitores/escritores | `PoseClient`, o adaptador de `HandClient` e `SpatialRuntime` iniciam/param captura. Apenas o pump registra/cancela rVFC/rAF e mantém o slot de processamento agendado. |
| Vida útil | Um pump vive com cada cliente, ou com uma ativação de adaptador legado do runtime. `pauseCapture` cancela callbacks agendados; `dispose` também encerra o cliente/worker. Pausar e retomar no mesmo worker não zera a sequência temporal. |
| Buffers | O pump não cria nem retém `ImageBitmap`. O provider/adaptador cria a cópia, fecha-a se a sessão ficar obsoleta e transfere a propriedade ao Worker no `postMessage`; após transferência, o buffer não é mutável nem fechável pelo chamador. |
| Invalidação | O pump usa uma geração privada para callbacks de scheduler. `cameraAttemptRef`, `PoseClient.captureEpoch`, o contador de sessão da mão e `SpatialRuntime.generation` mantêm seus significados atuais; cada ativação legada recebe um pump próprio, então trabalho pendente de um adapter não bloqueia o seguinte. |
| Ponto de commit | O frame é aceito pelo Worker quando `postMessage(FRAME, [bitmap])` retorna. O slot do pump só fica livre quando o resultado/erro desse frame foi resolvido ou quando o cliente é descartado. |
| Ordenação/progresso | Um frame em processamento por pump; não há fila. O próximo frame de vídeo é agendado, mas descartado enquanto o slot estiver ocupado. Erro de cópia/processamento reporta erro e libera o slot para quadros futuros. |
| Exceções | Falhas de `createImageBitmap` e de processamento chegam ao callback de erro. Erros fatais do Worker continuam sendo tratados pelo cliente. O pump não converte erro fatal em retry silencioso. |

### Trabalho e evidência

- [x] Linha de base determinística antes da migração: `npm test -- tests/poseClient.test.ts tests/handClient.test.ts tests/handCapture.test.ts tests/spatialRuntime.test.ts` — 4 arquivos, 17 testes passaram; os 5 testes de qualidade também passaram.
- [x] Revisão independente de três interfaces: captura pelo callback mínimo, pump genérico configurável e interface otimizada para o chamador comum.
- [x] Implementar o pump único e migrar os três caminhos de agendamento.
- [x] Preservar o método público `HandClient.processFrame` e o contrato de adaptadores de `SpatialRuntime` que só implementam `processFrame`.
- [x] Acrescentar testes determinísticos de backpressure, troca de sessão, fallback rAF, erros, pausa reentrante e lançamento síncrono.
- [x] Remover os loops duplicados já substituídos e revisar os chamadores pelo teste de exclusão; a busca confirmou que rVFC/rAF dos três caminhos agora aparece apenas no pump.
- [x] Executar suíte completa, lint e build; a revisão independente dos dois riscos encontrados foi concluída após as correções.

### Verificação e resultado

- Suíte completa com gravações locais existentes ligadas temporariamente à worktree (sem copiá-las): `npm test` — 54 arquivos, 440 testes aprovados; link removido depois da execução.
- Build de produção: `npm run build` — aprovado. Vite ainda informa o aviso preexistente de chunks acima de 500 kB.
- Lint: `npm run lint` — exit 0, com 28 avisos de CSS existentes. Os oito arquivos alterados passaram sem avisos em execução isolada do Biome.
- Artigos: `npm run check:articles` — aprovado (5 artigos PT, 5 EN e figuras no bundle).
- `git diff --check` — aprovado.
- Revisão independente encontrou e levou à correção de duas regressões: reentrância em `PoseClient.beginCapture` e fechamento de bitmap se um adaptador do runtime lança sincronamente. A segunda revisão não encontrou outros problemas concretos.

## Rodada 2 — limite de dependências da cinemática

### Mudança

- Os módulos de `src/kinematics` importam contratos de pose/calibração diretamente de `@wii/spatial-core`, removendo a dependência de tipos no re-export da camada `src/cv/protocol.ts` e, com ela, o ciclo de fonte com `src/cv/adaptiveCalibrator.ts`.
- Um override Biome aplicado somente a `src/kinematics/**` rejeita imports de CV/adapters, UI, jogos, páginas, React, Three.js e MediaPipe. Ele também bloqueia globais de DOM, vídeo, canvas, worker e animação.
- Imports do core são limitados a contratos de dados, `OneEuroFilter` e detectores puros já canônicos no pacote (como `RotationalFlickDetector`); o barrel misto não fica aberto para providers e runtime de browser.
- Imports internos proibidos usam padrões que cobrem profundidades diferentes. A regra também bloqueia leitura do relógio global: `kinematicsMs` não tinha consumidores e foi removido; `ActionPipeline.reset(timestampMs)` agora recebe o instante do coordenador.
- A regra usa os parsers AST do Biome já instalado e o lint que o CI executa; não foi adicionada dependência ou uma segunda ferramenta de verificação.

### Verificação

- [x] `npx biome lint src/kinematics` passou sem avisos.
- [x] Fixtures temporárias confirmaram que Three.js, imports relativos da CV em diretórios atuais e aninhados, jogos, globais DOM e o export `PoseClient` do core são rejeitados; as fixtures foram removidas.
- [x] Suíte completa com gravações locais existentes: `npm test` — 54 arquivos, 440 testes aprovados; links temporários removidos após os testes.
- [x] `npm run build` e `npm run check:articles` passaram; Biome passou com 28 avisos CSS existentes e nenhum aviso na pasta de cinemática; `git diff --check` passou.
- [x] Revisão independente confirmou os padrões aninhados, o relógio explícito e ausência de novos achados ou falsos positivos.

## Rodada 3 — erro fatal tardio dos Workers

### Invariantes de estado e ordenação

| Item | Decisão/estado observado |
| --- | --- |
| Donos | Cada `PoseClient`/`HandClient` possui seu Worker e estado `inFlight`; o Worker possui o Landmarker e decide quando a inferência/fallback deixou o Worker inutilizável. |
| Leitores/escritores | Os Workers enviam resposta de quadro e podem, depois, enviar o resultado da tentativa de fallback. Os clientes leem ambos na mesma fila de mensagens; uma resposta de quadro não encerra o ciclo de vida do Worker. |
| Vida útil | O Worker só é considerado atual quando ainda coincide com `this.worker`; `dispose()` invalida o cliente, fecha o worker e libera qualquer pedido ainda pendente. |
| Buffers | O bitmap é transferido no `postMessage(FRAME)` e fechado pelo Worker. Um erro posterior de fallback não devolve nem altera a posse do bitmap. |
| Invalidação | Erros recuperáveis continuam exigindo o pedido atual (`requestId` e `captureEpoch` para pose, `requestId` para mão). Erro fatal do Worker não é rejeitado por correlação de quadro, pois descreve a saúde global do Worker. |
| Ponto de commit | Receber erro fatal do Worker ainda ativo encerra o provider e reporta erro, mesmo se `POSE`/`HAND` já tiver liberado o quadro ou um quadro posterior estiver em voo. |
| Progresso | Ao encerrar, o cliente resolve o pedido pendente e interrompe captura; erros recuperáveis liberam somente o pedido correlacionado e deixam quadros futuros prosseguirem. |
| Exceções | A mensagem fatal preserva o status para a UI; o callback é capturado antes do `dispose()`, que limpa os callbacks internos. |

### Mudança e verificação

- O fallback por latência posta o resultado (`POSE`/`HAND`) e pode falhar depois ao inicializar CPU. A auditoria confirmou que os dois clientes descartavam o erro fatal atrasado por exigir que seu pedido ainda estivesse `inFlight`. Ao rebasear sobre a main atual, `PoseClient` já continha a invalidação do Worker ativo; essa semântica foi preservada e ganhou regressão explícita. `HandClient` ainda descartava o erro fatal atrasado.
- Foram adicionados testes determinísticos que primeiro reproduzem o resultado, iniciam outro quadro em voo e então entregam o erro fatal antigo. Ambos falhavam no pai original do lote; na main atual, o caso de pose já passa e o de mão exige a correção.
- `PoseClient` preserva o tratamento existente na main e sua nova regressão; `HandClient` agora trata erro fatal como condição do Worker ativo, liberando qualquer pedido restante. Erros não fatais mantêm a validação por ID/epoch.
- Os workers continuam com protocolos e configuração específicos. A auditoria não recomenda uma abstração genérica de Worker; a decisão de extrair somente a máquina de fallback fica pendente até comparar custos e transições.
- Suíte completa: 54 arquivos e 442 testes Vitest passaram; os cinco testes Node de qualidade também passaram. Os replays usaram somente os JSON locais existentes, ligados temporariamente e removidos do worktree após a execução.
- `npm run build`, `npm run check:articles`, `npx biome lint src/kinematics` e `git diff --check` passaram. `npm run lint` passou com 28 avisos CSS já existentes; nenhum aviso novo apareceu em kinematics.
- Revisão independente do caso com frame mais novo pendente não encontrou achados concretos.

## Rodada 4 — ativações de visão e ciclo de vida da câmera

### Invariantes antes da implementação

| Item | Decisão/estado observado |
| --- | --- |
| Donos | `App` possui a stream/câmera e escolhe a modalidade; cada cliente possui seu Worker e pode continuar inicializando depois de `pauseCapture()`. |
| Leitores/escritores | `startCamera`, o efeito de troca de tela e os callbacks/promises de Pose/Hand leem ou atualizam estado da câmera. `HandClient` pode notificar erro e rejeitar a inicialização em sequência. |
| Vida útil | A stream permanece viva ao trocar hand↔pose; os clients/Workers são reutilizados, e pausar captura não cancela uma inicialização pendente. |
| Buffers | A troca de ativação não altera posse nem transferência dos `ImageBitmap`; cada provider conserva seu contrato atual. |
| Invalidação | `cameraAttemptRef` continua invalidando a sessão física. `activateVisionMode` avança `visionActivationRef` nas transições e invalida callbacks, catches e inícios de captura anteriores, inclusive no ciclo hand→pose→hand. `screenRef` fecha o intervalo antes do efeito React. |
| Ponto de commit | Só callbacks e falhas pertencentes à ativação ainda atual podem mudar estado da câmera; falha de stream continua encerrando a sessão independentemente da modalidade. |
| Progresso | A ativação corrente inicia seu provider uma vez quando há stream, mesmo se a inicialização iniciada para uma modalidade anterior terminar com falha. O efeito React é a autoridade de início para o par sessão/ativação atual. |
| Exceções | Erro do provider ativo encerra câmera conforme o comportamento existente; erro obsoleto de provider é ignorado sem parar tracks ou captura ativa. Falhas de `getUserMedia`/vídeo continuam reportadas. |

### Mudança e verificação

- `activateVisionMode` centraliza a troca do modo ativo; `isCurrentVisionActivation` confere tentativa da câmera, geração da visão, modalidade ativa e tela solicitada. A sessão de câmera fica ligada à modalidade nova; falhas de provider antigo ficam isoladas.
- `captureStartedRef` faz o efeito React iniciar captura uma vez por par `{cameraAttempt, visionActivation}`. O efeito roda também quando `cameraOn` muda, então uma troca de tela durante `getUserMedia` ainda inicia o provider da tela atual quando a stream fica pronta.
- `startCamera` inicia o provider em paralelo com `getUserMedia`, mas observa a rejeição imediatamente. Só falhas do provider da ativação atual encerram a câmera; erros de stream e vídeo continuam encerrando a tentativa física.
- Falhas assíncronas de `startHandCapture`/`startPoseCapture` da ativação atual também encerram a câmera. Isso cobre a rejeição de `PoseClient.init()` sem callback de status; sem essa regra, a câmera ficava ligada sem tracking e sem nova tentativa.
- Removidos `observeEarlyRejection.ts` e seu teste: o único chamador agora anexa diretamente o tratamento da Promise na criação, sem precisar preservar uma Promise para um `await` posterior.
- Cinco testes determinísticos cobrem: erro de init de mão depois da troca para pose; fatal tardio do Worker de mão; erro de mão enquanto `getUserMedia` está pendente e início posterior de pose; ciclo hand→pose→hand com frame antigo; e rejeição do init de pose sem callback de status.
- O primeiro teste de interleaving e o teste da rejeição silenciosa de Pose foram executados antes da correção e falharam na asserção de stream/captura, confirmando o sinal vermelho específico.
- Suíte completa com gravações locais existentes: `npm test` — 54 arquivos e 446 testes Vitest aprovados; os cinco testes Node de qualidade também passaram. Os JSON foram ligados temporariamente à worktree e o link foi removido ao terminar.
- `npm run build`, `npm run lint`, `npm run check:articles`, `npx biome lint src/App.tsx tests/appVisionMode.test.tsx src/kinematics` e `git diff --check` passaram. O lint global mantém 28 avisos CSS existentes; os arquivos alterados não geram avisos isolados. O build mantém o aviso de chunks acima de 500 kB.
- Revisão independente final não encontrou achados após a correção do caso em que o init de Pose rejeita sem publicar status.

## Rodada 5 — isolamento de trabalho legado por geração

### Invariantes

| Item | Decisão/estado observado |
| --- | --- |
| Donos | `SpatialRuntime` escolhe e invalida providers por `generation`; cada pump serializa o trabalho de uma única ativação de adaptador legado. |
| Trabalho em voo | Adaptadores `processFrame` antigos não têm contrato de cancelamento. O runtime ignora seu resultado depois da troca e não espera a Promise antiga para avançar uma geração nova. |
| Commit | Cada ativação hand que usa somente `processFrame` cria um pump novo; `disposeActive()` para e solta a referência ao pump corrente. Uma conclusão antiga só libera o slot de seu próprio pump. |
| Buffer | A cópia criada pelo runtime continua sob o contrato de posse de `processFrame`; se a geração ficar obsoleta antes da chamada, o bitmap é fechado pelo runtime. |

### Mudança e verificação

- A revisão independente encontrou que o pump compartilhado mantinha `inFlight` depois de `stop()`. Um adapter antigo com Promise pendente bloqueava para sempre o adapter da próxima geração.
- O teste determinístico reproduziu a falha sem sleeps: mantém `processFrame` antigo pendente, troca hand→pose→hand e confirma que o novo adapter recebe seu primeiro quadro. O resultado antigo é resolvido depois e continua sem ser publicado.
- O teste falhou antes da correção e passou após criar um pump por ativação legada. `npm test -- tests/spatialRuntime.test.ts tests/videoFramePump.test.ts`: 12 testes passaram; os cinco testes Node de qualidade passaram.
- A garantia de um único quadro em voo continua dentro de cada pump, inclusive ao reiniciar o mesmo pump; gerações diferentes deixam de compartilhar o slot.

## Rodada 6 — propriedade da cena compartilhada

### Mudança

- `createSkyDome` era implementado em `games/track/scenery.ts` e chamado por Track, Athletics e Tennis. A localização fazia os outros jogos dependerem do módulo do curso legado.
- A implementação passou para `games/core/scenery.ts`; os três jogos usam o helper compartilhado, e `games/track/scenery.ts` mantém somente objetos específicos do Track.
- Os outros imports cruzados permanecem no backlog para revisão individual: `Feedback`, `RunGate` e `MiiRunner` têm semânticas e proprietários diferentes e não foram movidos por semelhança textual.

### Verificação

- `npm test`: 97 arquivos Vitest e 926 testes passaram; os cinco testes Node de qualidade também passaram. Os replays usaram as 14 gravações locais existentes via symlink temporário, removido ao fim da execução.
- `npm run build`, `npm run check:articles`, lint focado dos arquivos alterados e `git diff --check` passaram. `npm run lint` passou com 35 avisos CSS em arquivos sem alteração; o build mantém o aviso de chunks acima de 500 kB.
- Duas revisões independentes do diff completo não encontraram achados concretos; verificaram lifecycle de câmera, captura por geração e a extração do helper de cena.

## Rodada 7 — fechar brechas apontadas na revisão do PR #49

### Mudanças

- Callbacks de rVFC e rAF verificam a geração antes de limpar o handle ou atualizar `lastVideoTime`. O teste de captura inclui restart durante a entrega em lote de callbacks e exige que `stop()` cancele o handle novo.
- A regra `noRestrictedImports` agora bloqueia tanto subpaths privados do pacote quanto imports relativos para `packages/core/**` em kinematics. O barrel `@wii/spatial-core` continua permitindo somente os contratos listados.
- Probe com arquivo temporário confirmou que o import relativo privado falha e o import público de `PoseSnapshot` passa; o fixture temporário foi removido.

### Verificação e limite

- O teste de scheduler foi vermelho antes da correção e verde depois. `npm test` passou com 97 arquivos Vitest, 928 testes e cinco testes Node, usando somente as gravações locais existentes por symlink temporário removido ao final.
- `npm run build`, `npm run lint`, `npm run check:articles`, lint focado e `git diff --check` passaram. O lint global mantém 35 avisos CSS em arquivos não alterados; o build mantém avisos de chunks acima de 500 kB.
- A checagem manual real da webcam exigida no `AGENTS.md` ainda não foi feita: este ambiente não tem browser instalado nem `/dev/video*`. O PR declara essa pendência; precisa ser verificada numa máquina com webcam.

## Ciclo de melhoria

Cada lote termina com código migrado, teste na interface apropriada, exclusão segura da implementação substituída, restrição contra regressão quando aplicável e commit próprio. A lista ordenada e as decisões pendentes ficam em [architecture-backlog.md](architecture-backlog.md); decisões que passem o critério ADR ficam em `docs/adr/`.
