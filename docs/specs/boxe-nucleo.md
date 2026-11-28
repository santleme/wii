# SPEC — Núcleo do boxe: soco, bloqueio, esquiva

Status: em implementação · Data: 28/11/2026 · Autoria: pesquisa + evidência das gravações roteirizadas

## 1. Contrato do produto

O jogo de boxe precisa de exatamente três canais de entrada funcionando em condições de produção (webcam frontal, 11 fps, enquadramento tronco-e-cabeça, joelhos fora do quadro):

1. **Soco** — qualquer golpe para frente conta; tipo é modulação opcional, nunca requisito
2. **Bloqueio** — guarda alta sustentada reduz dano; não pode piscar nem ligar sozinha
3. **Esquiva** — inclinar o tronco para os lados (slip) ou para baixo/frente (duck) evita o golpe do oponente

Todo o resto — classificação fina de golpes, uppercuts por eixo próprio, footwork de ringue — é explícitamente fora de escopo até estes três canais atingirem os critérios de aceite abaixo.

## 2. Estado medido (gravação `boxe-CPU-1795872372127`, 918 frames, 11,1 fps)

| canal | recall onde deveria | precisão onde não deveria | veredito |
|---|---|---|---|
| soco | 71% dos onsets confirmam | 3 phantoms/83s em controles | funciona, precisão a melhorar |
| bloqueio (`guard`) | 53% no segmento guard | ~50% até em `still` | inaceitável |
| slip (`dodgeZone`) | 15% no segmento slip | 19% em bodyshot, 48% occlusion | quebrado |
| duck (`duck`) | **0%** — nunca liga | n/a | morto |

## 3. Restrições físicas medidas

- joelhos/tornozelos visíveis em 0% dos frames — canais de perna são impossíveis
- agachar com inclinação para frente **inverte** o sinal de altura em imagem (perspectiva: ombros sobem no quadro e largura cresce); y normalizado cai de ~2,0 para ~1,27 ao agachar
- baseline por imobilidade (800 ms, spread ≤0,05 sw) nunca se forma em movimento constante de boxe
- spikes de occlusion (y=5,58) exigem rejeição de outlier em qualquer canal
- quadris visíveis em 98% dos frames — canal de tronco disponível
- socos confirmam em 71% mas phantoms de slip/duck/guard custam 3 por gravação

## 4. Critérios de aceite (medidos no replay da gravação real por segmento)

### Soco (manter)
- recall de confirmação ≥ 65% dos onsets
- controles negativos (`still`, `prepare`, `occlusion`): zero socos
- phantoms em defesa (slip/duck/guard): ≤ 1 por gravação — requer o item 5

### Bloqueio
- ≥ 75% dos frames no segmento `guard`
- ≤ 20% dos frames em `still` e `prepare`
- ≤ 25% em segmentos de soco (cross/hook) — a mão que soca sai da guarda, a outra fica

### Esquiva
- `duck`: ≥ 50% dos frames no segmento duck; ≤ 10% em `still`/`guard`/`prepare`
- `slip`: ≥ 40% dos frames no segmento slip; ≤ 10% em `still`/`guard`; ≤ 15% em segmentos de soco

## 5. Direções de design (evidência no plano-boxe.md)

- **Duck**: abandono da altura absoluta. Candidatos por ordem de promessa física: (a) pitch do tronco no frame mundo (vetor ombro→quadril ganha z ao inclinar — invariante a enquadramento, quadris 98% visíveis); (b) encurtamento do tronco em imagem por foreshortening; (c) crescimento da largura de ombros. Sinal composto provável. Baseline adaptativa por percentil, nunca por imobilidade.
- **Bloqueio**: correção geométrica, não temporal (histerese testada e rejeitada — amplifica falso positivo). Candidato: evidência punho-perto-do-rosto em vez de banda de altura larga.
- **Slip**: congelar calibração de lane durante janelas de soco (soco não é deslocamento de base); revisitar adoção de baseline.
- **Phantom de soco em defesa**: suprimir confirmação enquanto esquiva ativa — custo físico aceitável (soco em slip pleno é raro).

## 6. Processo de validação

Toda mudança mede contra o replay da gravação real por segmento (harness existente) antes de entrar. Resultados negativos são documentados com a evidência — valem tanto quanto positivos. UTD-MHAD fora de uso até re-coleta das gravações (perdidas com o worktree anterior).
