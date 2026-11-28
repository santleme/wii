# Pesquisa: comportamento de adversários em tênis, boxe e atletismo

Atualização: 28/11/2026. Escopo: adversários de um arcade com câmera e simulação local; não foi encontrado um estudo que valide diretamente estes parâmetros, a experiência de seus jogadores ou o protótipo local. Fontes primárias foram conferidas em 28/11/2026. O desenho recomendado é hipótese de engenharia; números de atletas e resultados de outros jogos não são garantia de realismo, diversão ou desempenho aqui.

## Achados e limites

| Fonte primária | O que mostra | Uso neste projeto e limite |
| --- | --- | --- |
| [Mark e Dill, utility theory](https://www.gdcvault.com/play/1012410/Improving-AI-Decision-Modeling-Through2d) | Modelagem de decisões de jogo por utilidade. | Pontuar ações legais com fatores nomeados para estilos explicáveis. Não comprova pesos nem melhora subjetiva neste jogo. Confiança alta na descrição; média na recomendação de projeto. |
| [Reynolds, steering behaviors](https://www.red3d.com/cwr/papers/1999/gdc99steer.pdf) | Separa objetivo, condução e locomoção. | Separar intenção de interceptar/evadir da integração do movimento; posição física decide contato. Confiança alta na separação; aplicação específica é hipótese. |
| [Match Point AI, artigo completo](https://arxiv.org/html/2408.05960) | Compara políticas em simulação de tênis baseada em sequências anotadas. | Justifica comparar políticas e pontos **e** partidas, não copiar taxas. Não modela posição/movimento de jogadores nem velocidade da bola; quase metade da amostra do agente médio vem de dez jogadores. Confiança alta na limitação, baixa na transferência quantitativa. |
| [Match Charting Project](https://github.com/JeffSackmann/tennis_MatchChartingProject#license) | Sequências de jogadas anotadas por voluntários, licença CC BY-NC-SA 4.0. | Pesquisa exploratória com viés de seleção; não importar nem distribuir dados, modelos ou parâmetros derivados até verificar direitos e adequação ao uso do projeto. Não usar como fonte de tempo de reação/interceptação. |
| [Vid2Player3D](https://research.nvidia.com/labs/toronto-ai/vid2player3d/) | Imitação física em duas camadas treinada com vídeos em larga escala. | Demonstra possibilidade, mas requer dados, treino e simulação fora do escopo atual; não indica que executar um modelo no navegador trará melhor experiência. |
| [BoxingVI](https://arxiv.org/html/2511.16524) | O resumo relata 6.915 golpes anotados, seis classes, 20 vídeos e 18 atletas; a legenda de uma figura menciona 20 sujeitos. Dados são links e marcações. O artigo coloca interação entre adversários como trabalho futuro. | Inspiração de taxonomia, não base de política de combate nem de detecção frontal por webcam. Direitos dos vídeos e licença do dataset devem ser verificados antes de qualquer uso. |
| [UTD-MHAD](https://personal.utdallas.edu/~kehtar/UTD-MHAD.html) | Reconhecimento de 27 ações individuais capturadas com Kinect e sensor inercial. | Não fornece decisões em luta; a análise local em `plano-boxe.md` documenta discrepâncias de postura e câmera. Não extrapolar desempenho para jogadores reais ou tipos de golpe. |
| [World Athletics, 100 m masculino](https://worldathletics.org/download/download?filename=51b04ff3-8549-4747-b066-5bd77aeaee38.pdf&urlslug=Men%27s+100m+-+2017+IAAF+World+Championships+Biomechanical+report) e [400 m masculino](https://worldathletics.org/download/download?filename=8a95b26a-333d-4b05-b935-08f48f434e20.pdf&urlslug=Men%27s+400m+-+2017+IAAF+World+Championships+Biomechanical+report) | Relatórios observacionais de elite, também disponíveis no [índice oficial](https://worldathletics.org/about-iaaf/documents/research-centre). Na final de 400 m em Londres 2017, as parciais de Wayde van Niekerk foram 10,85 / 9,93 / 10,86 / 12,34 s; a primeira inclui a reação de largada. | Apoia aceleração e perda de velocidade dependente da prova; não é distribuição representativa de jogadores de webcam, nem justifica sprint final obrigatório. Não copiar tempos literalmente. |
| [Ang e Mitchell, avaliação de ajuste dinâmico](https://doi.org/10.1145/3116595.3116623) | Compara métodos de ajuste e experiência em um jogo estudado. | Motivação para testar autonomia e sensação de controle; acesso integral retornou 403 nesta pesquisa, logo detalhes e tamanhos de efeito não foram verificados. Não usar como prova de superioridade de DDA aqui. |

O [estudo experimental sobre antecipação em boxe](https://pubmed.ncbi.nlm.nih.gov/25385452/) compara grupos em uma tarefa experimental de tela, não em luta com webcam; não fornece um tempo de reação universal aplicável ao NPC. Adaptação a hábitos e dificuldade são conceitos separados: a primeira pode mudar a escolha entre ações legais; a segunda muda capacidade ou desafio. Começar com capacidade fixa e memória limitada, e só considerar DDA de capacidade depois de validação específica.

## Medição exploratória da corrida atual

Em Node 24.15.0, executei diretamente `Race` de `origin/main` (`f001f6d`) e da worktree local, com `dt=1/60`, fase `racing`, sem esforço do jogador, até os três rivais terminarem; `RestartGesture` foi substituído por stub porque não participa da corrida. Não é benchmark de CPU nem estudo humano. Resultados em segundos:

| Prova | Base: Bia / Caio / Davi | Protótipo local: Bia / Caio / Davi |
| --- | --- | --- |
| 100 m | 20,200 / 17,833 / 15,976 | 20,651 / 18,365 / 16,604 |
| 200 m | 41,020 / 36,141 / 32,313 | 41,667 / 36,775 / 33,156 |
| 400 m | 89,718 / 78,962 / 70,522 | 91,260 / 80,061 / 72,365 |

Essas nove trajetórias determinísticas mostram que a tentativa local tornou os rivais mais lentos, não que melhorou o jogo; não cobrem variação, interação com jogador nem percepção de justiça. O plano requer medições mais amplas e não aprova os parâmetros atuais por causa desta tabela.

Após a implementação de perfis de atletismo, uma segunda execução no mesmo ambiente usou 100 sementes por prova (gerador Mulberry32, sementes 1–100), com a mesma base fixa. Médias e intervalos mínimo–máximo em segundos:

| Prova | Bia | Caio | Davi |
| --- | --- | --- | --- |
| 100 m | 20,445 (20,139–20,718) | 18,193 (17,918–18,429) | 16,431 (16,206–16,652) |
| 200 m | 41,381 (40,747–41,948) | 36,542 (35,972–37,031) | 32,907 (32,438–33,366) |
| 400 m | 90,542 (89,134–91,798) | 79,469 (78,208–80,550) | 71,742 (70,699–72,761) |

Estes números são amostras sintéticas de perfis sem câmera ou jogador, e não validam percepção de dificuldade ou desempenho do navegador. Os intervalos são mínimo e máximo observados, não intervalo de confiança.

## Dados e avaliação

Não existe, nesta pesquisa, corpus representativo e licenciado de partidas deste arcade. Fontes sintéticas servem a invariantes e comparação de regressões; não comprovam que a experiência humana melhorou. Gravações reais já previstas em `tests/recordings/` são privadas e opcionais; ausência delas deixa validação de câmera pendente. Dados coletados para avaliação devem permanecer locais, com consentimento, sem vídeo no repositório ou upload automático. Dados públicos só podem ser integrados quando origem, termos, cobertura e possível derivação forem revisados.

Comparar versões com sementes e entradas idênticas, usando resultados por cenário e distribuições: duração e desfecho de rallies; frequência de ataques, evasões legíveis e ações fora de alcance; curvas e tempos de corrida. Testar com pessoas de habilidades diferentes, com ordem balanceada, e registrar desafio, clareza, justiça e diversão separadamente. Uma taxa de vitória não mede nenhuma dessas qualidades sozinha. Fixar metas quantitativas **antes** de comparar a versão final, após medir a linha de base; não inventar medições ou prometer p95 de desempenho sem hardware real e protocolo.

## Conclusão e lacunas

A escolha inicial é IA por esporte com observação delimitada, estados de execução, opções legais pontuadas e memória curta em sessão; a previsibilidade e o custo são controláveis e testáveis. É uma proposta de engenharia, não um resultado provado superior a aprendizado de máquina. Não incluir LLM, GOAP, MCTS ou política aprendida no loop apenas pelo nome; investigar se cenários de avaliação revelarem uma necessidade que a solução não resolve. Lacunas: validação de câmera real, calibração numérica, estudos com jogadores, medidas de frame time/inferência e verificações de licença de dados externos. O plano de implementação e a revisão do protótipo estão em [plano-ia-npcs.md](plano-ia-npcs.md).
