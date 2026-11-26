# Pesquisa profunda — engajamento saudável em jogos arcade: o que a evidência sustenta

Data: 25 de novembro de 2026 · Branch: `feat/engagement-loop` (`ecd481e`)
Pergunta: como tornar jogos arcade altamente engajadores **de forma saudável** — cobrindo flow, dificuldade adaptativa, feedback imediato, objetivos curtos, progressão, maestria, variabilidade, recompensas, competição e o efeito "uma partida a mais" — e o que disso é implementável numa web app estática controlada por pose (corrida e tênis).

Método: síntese de fontes primárias verificadas — artigos e livros acadêmicos lidos no original ou em texto completo/abstract oficial (Psychological Bulletin, JPSP, CHI PLAY, Entertainment Computing, Royal Society Open Science, PLOS One, ICD-11 da OMS), mais documentação oficial de plataformas (Google Play Games, Apple Game Center) e fatos históricos da era arcade com fonte primária de museu/Guinness. Nada aqui é citado de segunda mão sem aviso; onde a evidência é fraca, mista ou inexistente, está dito.

Rótulos de evidência: **[EA]** experimento controlado acadêmico · **[AM]** meta-análise/revisão sistemática · **[AC]** evidência correlacional/observacional · **[AT]** teoria ou modelo acadêmico ainda não testado diretamente · **[P]** documentação oficial de plataforma (não revisada por pares) · **[H]** heurística da indústria ou fato histórico · **[Inf]** inferência/síntese nossa, não resultado direto de fonte.

---

## 1. Resumo executivo

1. **O engajamento duradouro nasce de satisfação de necessidades psicológicas, não de truques de retenção.** Autonomia, competência e relacionamento (SDT) preveem diversão, vontade de jogar de novo e bem-estar pós-jogo em quatro estudos (Ryan, Rigby & Przybylski 2006) [EA]. E o tempo de jogo em si praticamente **não afeta** o bem-estar — o que importa é a motivação durante o jogo (Vuorre et al. 2022, 38.935 jogadores, telemetria real de 7 publishers) [EA longitudinal]. Ou seja: otimizar "minutos jogados" é otimizar a métrica errada; otimizar a *qualidade* da sessão é o caminho saudável — e é também o que gera retorno voluntário.
2. **Flow tem três condições de entrada com suporte causal: desafio equilibrado à habilidade, objetivos claros e feedback imediato** (Nakamura & Csikszentmihalyi 2002; Keller & Bless 2008 experimental; Schaffer & Fang 2022 experimental) [EA]. Dessas, as duas últimas são baratas de implementar e estão ausentes ou fracas no projeto hoje.
3. **Dificuldade adaptativa melhora performance objetivamente, mas o efeito sobre diversão/flow é misto** — e quando o ajuste é imposto pelo sistema, pode reduzir a sensação de controle, que é ingrediente de flow (Ang & Mitchell 2017; Robb & Zhang 2022) [EA]. A solução com melhor suporte teórico+empírico é a **dificuldade adaptativa visível e agêntica**: rampa explícita, escolhas de risco dentro do jogo (Chen 2007 [AT]) e ajuste declarado ao jogador, nunca invisível.
4. **Feedback ajuda — mas só se for relevante à tarefa, e não pode ser excessivo.** Feedback sobre progresso aumentou flow contra grupos-controle sem feedback e com feedback aleatório (Schaffer & Fang 2022) [EA]. "Juiciness" (embelezamento audiovisual) tem relação em **U invertido** com tempo de jogo, experiência e motivação intrínseca: nem nada nem extremo — médio/alto é o ótimo (Kao 2020, N=3.018) [EA]. Feedback deve focar a tarefa, ser específico e vir em doses digeríveis (Shute 2008) [AM narrativa].
5. **Objetivos específicos e difíceis superam "faça o seu melhor"** (tamanhos de efeito d=0,42–0,80 em meta-análises; maiores em tarefas simples — o caso do arcade) e **objetivo+feedback juntos superam objetivo sozinho** (Locke & Latham 2002) [AM]. Score e metas em camadas simultâneas já eram correlatos de popularidade em 1981 (Malone) [AC]. O detalhe acionável: **progresso visível em direção ao objetivo acelera o esforço conforme se aproxima** (goal-gradient; Kivetz, Urminsky & Zheng 2006) [EA de campo].
6. **O "vale" pós-conquista é real e previsível**: depois de atingir uma recompensa, o engajamento cai e só reacelera quando a próxima meta se aproxima (*post-reward resetting*, mesmo paper) [EA]. Toda progressão deve ter o próximo marco visível no instante da conquista.
7. **Recompensas tangíveis esperadas e contingentes corroem motivação intrínseca** (meta-análise de 128 estudos, d=−0,28 a −0,40; Deci, Koestner & Ryan 1999) [AM]; **feedback positivo/verbal aumenta** motivação (d=+0,31 a +0,33) e **recompensas inesperadas não minam** (Lepper, Greene & Nisbett 1973) [EA]. Regra de design: comemore performance com informação e surpresa; nunca transforme jogar em meio para ganhar coisa.
8. **Competição funciona melhor combinada com cooperação, e em exergames cooperação supera competição direta** (Tauer & Harackiewicz 2004 [EA]; Staiano, Abraham & Calvert 2012 [EA]). Para um app local sem servidor, a forma saudável e testada é a **competição assíncrona contra si mesmo e contra familiares** — a tabela de recordes com iniciais existe desde 1979 exatamente para isso (Asteroids; Guinness/Strong Museum) [H].
9. **Exergames têm duas balanças para equilibrar, não uma**: habilidade×desafio (psicológica) e aptidão×intensidade (fisiológica) — o modelo *dual flow* (Sinclair, Hingston & Masek 2007) [AT]. E têm um risco que jogos de sofá não têm: **sobreexertão e lesão** (Mueller et al. 2011, "risk of exertion") [AT+estudos de caso]. Design saudável de exergame inclui rounds curtos e pausas sem punição — o oposto do "playing by appointment".
10. **Os limites éticos são claros e documentados**: grinding, agendamento com punição, escassez artificial e recompensas aleatórias monetizadas são dark patterns catalogados (Zagal, Björk & Lewis 2013); loot boxes se associam a jogo problemático (Zendle & Cairns 2018, n=7.422) [AC]; a OMS reconhece gaming disorder, mas ele atinge pequena minoria e se define por prejuízo funcional — não por tempo jogado (OMS, ICD-11). Nada disso é necessário para engajar: todo mecanismo recomendado aqui opera por motivação intrínseca.

---

## 2. Fundamentos: por que jogos prendem atenção

### 2.1 A teoria da autodeterminação aplicada a jogos (SDT/PENS) [EA]

Ryan, Rigby & Przybylski (2006, *Motivation and Emotion* 30:347–363, [PDF](https://www.selfdeterminationtheory.org/SDT/documents/2006_RyanRigbyPrzybylski_MandE.pdf), [DOI](https://doi.org/10.1007/s11031-006-9051-8)) testaram em quatro estudos se a satisfação das necessidades de **autonomia** (volição, escolha), **competência** (eficácia, desafio ótimo) e **relacionamento** explica o "pull" dos videogames. Achados verificados no texto:

- Autonomia e competência percebidas no jogo se associam a diversão, preferência e melhora de bem-estar pré→pós-jogo; as três necessidades preveem independentemente diversão e **intenção de jogar no futuro** (estudo 4).
- **Controles intuitivos** — os que "fazem sentido, são facilmente dominados e não interferem com a sensação de estar no jogo" — se relacionam a autonomia e competência percebidas, e os autores testam o modelo em que os efeitos motivacionais do controle intuitivo são **mediados por autonomia e competência**. Ou seja: a interface não engaja por si; ela engaja porque entrega controle e eficácia.
- "Provisões de escolha, uso de recompensas como **feedback informacional** (em vez de controle de comportamento) e instruções não-controladoras demonstraram aumentar autonomia e, por sua vez, motivação intrínseca."

**Implicação direta para este projeto** [Inf]: num jogo controlado pelo corpo, a *calibração e a confiabilidade do tracking* são a camada de "controles intuitivos" — o equivalente ao input lag e ao mapeamento de botões num jogo tradicional. Cada frame perdido ou gesto não detectado é competência percebida destruída. Investimento em UX de calibração e tolerância a falhas **é** investimento em engajamento (converge com `docs/analise-gargalos-corrida.md` e `docs/pesquisa-exposicao-minima-calibracao.md`).

### 2.2 Flow: condições verificadas no texto primário [AT+EA]

Nakamura & Csikszentmihalyi (2002, "The Concept of Flow", *Handbook of Positive Psychology*, [PDF](https://nuovoeutile.it/wp-content/uploads/2015/12/2002-Flow.pdf)) — condições de entrada, verbatim do capítulo:

> "• Perceived challenges, or opportunities for action, that stretch (neither overmatching nor underutilizing) existing skills; a sense that one is engaging challenges at a level appropriate to one's capacities • Clear proximal goals and immediate feedback about the progress that is being made."

E a dinâmica: "Being 'in flow' is the way that some interviewees described the subjective experience of engaging just-manageable challenges by **tackling a series of goals, continuously processing feedback about progress, and adjusting action based on this feedback**." O equilíbrio é intrinsecamente frágil: desafio acima da habilidade → vigilância e depois **ansiedade**; habilidade acima do desafio → relaxamento e depois **tédio** — e ambos pressionam a pessoa a reajustar, o que explica por que jogos com caminho de maestria "auto-regulam" o engajamento.

Status empírico (scoping review de Peifer et al. 2022, [Frontiers](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2022.815665/full)) [AM narrativa]: o balanço desafio–habilidade é a condição com evidência mais estável (incl. meta-análise de Fong et al. 2015, junto a objetivos claros e senso de controle). Importante: as três condições são **antecedentes**, não a experiência em si — e nem todos os jogadores entram em flow igualmente fácil (moderadores de personalidade em Keller & Blomann 2008).

### 2.3 A taxonomia de Malone: o arcade já nasceu sabendo [AC+H]

Malone (1981, *Cognitive Science* 5(4):333–369, [Wiley](https://onlinelibrary.wiley.com/doi/10.1207/s15516709cog0504_2)) [AC]: o que torna jogos de computador intrinsecamente motivadores se organiza em **desafio, fantasia e curiosidade**. Desafio depende de **objetivos com resultado incerto** — e a incerteza vem de: nível de dificuldade variável, objetivos em múltiplos níveis, informação escondida e aleatoriedade.

Malone (1982, "Heuristics for Designing Enjoyable User Interfaces", [PDF](https://www.hcs64.com/files/Malone-Heuristiques.pdf)) [AC]: nas suas amostras, os recursos **correlacionados com a popularidade dos jogos eram: presença de objetivo explícito, score-keeping, efeitos de áudio e aleatoriedade**. Do mesmo texto, duas lições de design de objetivos em camadas:

- "long before there is any hope of a beginning player breaking out all the bricks, the player can still be challenged by lower level goals like breaking out any brick in the third row" — **objetivos de vários níveis presentes ao mesmo tempo**; score e tempo são as formas comuns de criá-los.
- A citação original da famosa máxima de Nolan Bushnell (Atari): **"A good game should [be] easy to learn, but difficult to master"** — e o mecanismo do Breakout: "after a player hits the ball correctly five times in a row, the ball speeds up". É o ancestral documentado da dificuldade adaptativa de arcade [H].

Sweetser & Wyeth (2005, GameFlow, *Computers in Entertainment* 3(3), [PDF](https://svn.sable.mcgill.ca/sable/courses/COMP763/newpapers/sweetser-05-gameflow.pdf)) [AT] consolidam oito elementos de diversão em jogos — concentração, desafio, habilidade, controle, objetivos claros, feedback, imersão e interação social — derivados de flow; útil como checklist, mas é modelo de avaliação heurística, não resultado experimental.

---

## 3. Desafio × habilidade e dificuldade adaptativa: o que é fato e o que é misto

### 3.1 O vínculo causal desafio–habilidade → flow [EA]

Keller & Bless (2008, *Personality and Social Psychology Bulletin* 34:196–209, [abstract](https://pubmed.ncbi.nlm.nih.gov/18212330/)): primeiro paradigma **experimental** (contra a literatura correlacional anterior) a demonstrar impacto causal da compatibilidade habilidade–demanda sobre flow — usando Tetris com velocidade de queda reajustada ao desempenho do jogador. Keller, Ringelhan & Blomann (2011, *Journal of Positive Psychology* 6(5):408–417, [abstract](https://www.tandfonline.com/doi/full/10.1080/17439760.2011.604041)) foram além: a compatibilidade gera flow em tipos diferentes de atividade, e o flow aumenta **a vontade de reengajar a atividade em situação de livre escolha** — a medida comportamental de motivação intrínseca. Esta é a cadeia causal mais bem documentada da literatura para o "uma partida a mais": **equilíbrio → flow → reengajamento voluntário**.

### 3.2 Dificuldade adaptativa dinâmica (DDA): evidência e ressalvas

- **Hunicke & Chapman (2004, [PDF](https://users.cs.northwestern.edu/~hunicke/pubs/Hamlet.pdf))** — o paper fundador do DDA moderno — abre com a lei do arcade: "Video games are boring when they are too easy and frustrating when they are too hard". É um trabalho de **arquitetura** (Hamlet/Half-Life, teoria de estoques), não um estudo de experiência de jogador — a prescrição é forte, mas a evidência empírica veio depois [AT].
- **Ang & Mitchell (2017, CHI PLAY, pp. 317–327, [ACM](https://dl.acm.org/doi/10.1145/3116595.3116623))** [EA, primeira comparação experimental direta]: três condições — sem DDA, DDA de rampa imposta pelo sistema (rDDA) e DDA orientada ao jogador (pDDA). "The presence of DDA was found to produce better overall game experiences. **However**, players in the rDDA condition experienced less self-consciousness and more transformation of time but **a lower sense of control** compared to the players in the pDDA condition." Lição: DDA automática invisível compra imersão temporal mas pode cobrar em controle percebido — e controle é condição de flow (§2.2).
- **Robb & Zhang (2022, *Acta Ludologica* 5(1), [PDF](https://actaludologica.com/wp-content/uploads/2022/06/AL_2022-5-1_Study-1_Robb-Zhang.pdf))** [EA, n=221]: DDA baseada em performance produziu **performance significativamente melhor** e comprimiu a dispersão de habilidade entre jogadores ("performance-based DDA is suitable for reducing skill differentials between players" — implicação para acessibilidade e para multiplayer doméstico com habilidades distintas). **Mas**: "no significant differences between the three conditions on all the self-reported measures of player experience (flow, enjoyment, challenge, and anxiety)". O próprio paper registra que a literatura anterior é mista em medidas de experiência.
- **Chen (2007, "Flow in Games (and Everything Else)", *Communications of the ACM* 50(4):31, [PDF](https://jenovachen.com/flowingames/p31-chen.pdf); tese MFA, [completa](http://www.jenovachen.com/flowingames/Flow_in_games_final.pdf))** [AT]: em vez de DDA passiva inferindo dados incompletos, oferecer **escolhas ativas e transparentes** dentro do gameplay para o jogador auto-calibrar o desafio ("active DDA"; no flOw: "transparent and meaningful choices; small risk, small reward; big risk, big reward; minimal penalty, no Flow breakers"). É teoria de design, não experimento — mas convergente com o achado empírico de Ang & Mitchell de que a versão orientada ao jogador preserva controle.
- Fato histórico útil [H]: a rampa de dificuldade mais famosa do arcade foi **acidental** — Space Invaders (1978) acelerava porque o microprocessador tinha menos sprites para renderizar ([Den of Geek, resenha histórica](https://www.denofgeek.com/games/first-video-game-high-score-invented-history/); [Strong Museum](https://www.museumofplay.org/games/asteroids/)). O efeito era percebido e amado pelos jogadores: a rampa **visível** faz parte da narrativa de maestria.

**Síntese** [Inf]: a evidência sustenta três prescrições e uma proibição. (1) Ajuste de dificuldade em função de desempenho melhora performance e nivela habilidades — útil sobretudo num jogo em que a "habilidade" depende de fatores físicos fora de controle do design (corpo, cômodo, câmera). (2) O ajuste deve ser **perceptível e agentivo**: níveis explícitos, rampa anunciada, escolhas de risco ("barreira alta vale o dobro") — nunca rubber-banding invisível. (3) A curva deve subir *com* o jogador dentro da sessão (o ancestral do Breakout) porque é isso que mantém a razão desafio/habilidade à medida que a maestria cresce. (4) Não tratar DDA como substituto de design de objetivos/feedback — os efeitos de experiência são mistos exatamente quando ela é a única alavanca.

---

## 4. Feedback imediato: a alavanca mais barata — com dose certa

### 4.1 Feedback de progresso causa flow — se for relevante à tarefa [EA]

Schaffer & Fang (2022, *AIS Transactions on HCI* 14(3):356–389, [artigo](https://aisel.aisnet.org/thci/vol14/iss3/4)): experimento controlado entre sujeitos com quatro versões de um jogo — sem feedback, feedback aleatório (sem relação com desempenho) e dois tratamentos com feedback **task-relevant** sobre progresso. A manipulação teve efeito grande no feedback percebido (η²=0,248) e os participantes com feedback relevante **reportaram mais flow que ambos os controles**. Detalhe de design que vale ouro: feedback aleatório/não-informativo não ajuda — não é "qualquer resposta audiovisual", é resposta que informa *quão bem* e *como melhorar*.

### 4.2 "Juiciness" tem ótimo em U invertido [EA]

Kao (2020, *Entertainment Computing* 34:100359, [DOI](https://doi.org/10.1016/j.entcom.2020.100359); maior estudo do tipo, **N=3.018**): quatro versões idênticas de um action-RPG variando a quantidade de feedback positivo audiovisual (nenhum/médio/alto/extremo). Verbatim do abstract: "**both None and Extreme amounts of juiciness lead to significantly decreased play time, significantly decreased player experience, significantly decreased intrinsic motivation, and significantly decreased performance** relative to both Medium and High." O extremo destrói tanto quanto a ausência — hipótese dos autores e de trabalhos seguintes: feedback redundante sobrecarrega a memória de trabalho e perde valor informacional. Heurística "juice it or lose it" da indústria [H] é portanto verdadeira só até a metade da escala.

### 4.3 Feedback para aprendizagem motora — a nuance que importa num jogo de corpo [AM, com ressalva forte]

Como o input deste projeto é movimento corporal, a literatura de aprendizagem motora é diretamente relevante:

- Salmoni, Schmidt & Walter (1984, *Psychological Bulletin* 95(3):355–386, [DOI](https://doi.org/10.1037/0033-2909.95.3.355)): a **hipótese da guiança** — feedback aumentado dado a cada tentativa melhora a performance *durante* a prática mas pode degradar a aprendizagem (retenção sem feedback), porque o aprendiz terceiriza a autodetecção de erro. Schmidt et al. (1989, [PubMed](https://pubmed.ncbi.nlm.nih.gov/2522520/)) mostraram relação em U invertido entre comprimento do resumo de feedback e retenção.
- **Ressalva obrigatória**: a meta-análise de 2022 (*Psychology of Sport and Exercise*, [DOI](https://doi.org/10.1016/j.psychsport.2022.102165); 61 artigos, N=2.228) **não confirmou** o efeito — heterogeneidade alta, estudos subdimensionados, "robust evidence regarding feedback frequency and motor learning is lacking". O canon de manual é mais frágil do que parece.
- Shute (2008, "Focus on Formative Feedback", *Review of Educational Research*, [DOI](https://journals.sagepub.com/doi/10.3102/0034654307313795)) [AM narrativa clássica] — prescrições verificadas na Tabela 2 do paper: feedback **na tarefa, não na pessoa**; **elaborado** (o quê, como, por quê), mas **em unidades digeríveis**; **específico e claro**, ligado a objetivos e performance; "as simple as possible but no simpler". Sobre timing: a literatura de imediato×tardio é mista, com imediato favorecido para tarefas difíceis/em aquisição inicial e eficiência de curto prazo.

**Síntese** [Inf]: para este projeto, a leitura conjunta é: (1) feedback imediato e contínuo *in-game* sobre ações discretas (salto limpo, contato, ritmo) — suporte forte (§4.1); (2) embelezamento audiovisual em dose médio-alta, escalonado por magnitude do evento, nunca extremo constante (§4.2); (3) para a dimensão *maestria do gesto* (forma do swing, postura de corrida), feedback corretivo em **resumo de fim de round**, específico e acionável, em vez de correção contínua em tempo real — o que evita tanto a sobrecarga de trabalho em flow quanto o risco de guiança, sem custo conhecido (§4.3); (4) nunca feedback sobre a pessoa ("você é ruim") — sempre sobre a ação ("contato tarde — inicie o swing mais cedo").

---

## 5. Objetivos curtos, progressão e maestria

### 5.1 Objetivos específicos e difíceis: a teoria mais replicada da motivação [AM]

Locke & Latham (2002, *American Psychologist* 57(9):705–717, [PDF](https://goal-lab.psych.umn.edu/orgPsych/readings/5.%20Motivation/Locke%20%26%20Latham%20%282002%29.pdf)) — 35 anos de pesquisa destilados, verificado no original:

- "specific, difficult goals consistently led to higher performance than urging people to do their best. **The effect sizes in meta-analyses ranged from .42 to .80**. In short, when people are asked to do their best, they do not do so."
- Moderadores: **objetivos + feedback é mais efetivo que objetivos sozinhos**; efeito menor em tarefas complexas (d=0,48) que em simples (d=0,67) — arcade é majoritariamente tarefa simples/repetitiva, o caso de efeito máximo. Em tarefas complexas ainda não dominadas, **objetivos de aprendizagem** superam objetivos de performance ("descobrir como executar X" em vez de "atingir N pontos") — aplicável ao onboarding de gestos novos.
- Comprometimento com o objetivo modera o efeito — objetivos auto-escolhidos ou participados comprometem mais.

### 5.2 Goal-gradient e a ilusão de progresso: a física da barra de progresso [EA de campo]

Kivetz, Urminsky & Zheng (2006, *Journal of Marketing Research* XLIII:39–58, [PDF](https://business.columbia.edu/sites/default/files-efs/pubfiles/1200/goalgradient.pdf)) — ressuscitaram a hipótese de Hull (1932) em humanos, verificado no original:

- Clientes de um café **compravam mais rápido conforme se aproximavam** da recompensa (tempos entre compras caem ~20%, 0,7 dia, ao longo do programa); na tarefa de avaliar músicas online, visitas mais frequentes, mais avaliações por visita e mais persistência perto da meta.
- **Ilusão de progresso**: quem recebeu cartão de 12 selos com 2 selos "bônus" pré-carregados completou as 10 compras exigidas mais rápido que quem recebeu o cartão regular de 10 — o esforço é função da *proporção restante percebida*, não da distância absoluta.
- **Post-reward resetting**: após completar a primeira recompensa, o ritmo **cai** no início do segundo ciclo (primeiras intercompras do 2º cartão significativamente mais lentas que as últimas do 1º, p<.05) e reacelera conforme a nova meta se aproxima. Verbatim: "Members accelerated their coffee purchases toward their first reward and then slowed down when they began working toward their second reward."

**Implicações** [Inf]: (1) toda meta precisa de barra/indicador de progresso contínuo — não basta existir objetivo; (2) marcos próximos aceleram — fragmentar progressões longas em marcos curtos explora a aceleração honestamente (o progresso é real, não fabricado); (3) o instante mais perigoso para abandono é o segundo seguinte à conquista — o design deve **sempre mostrar o próximo marco no momento da celebração**; (4) "progresso dado de graça" (a ilusão) funciona mas é manipulativo quando fabricado — uso legítimo: contar retrospectivamente feitos já realizados ("você já saltou 40 vezes nesta sessão — faltam 10 para o marco de 50").

### 5.3 High scores: a progressão original do arcade — e o que as plataformas prescrevem hoje [H+P]

História verificada: Sea Wolf (1976) introduziu o termo "high score" (sem persistir); **Space Invaders (1978) foi o primeiro a reter o recorde entre partidas**; **Asteroids (1979) foi o primeiro com tabela personalizada de iniciais** ([Guinness World Records](https://www.guinnessworldrecords.com/world-records/first-video-game-to-include-a-personalized-high-score-table); [The Strong Museum](https://www.museumofplay.org/games/asteroids/): "the drive to add one's initials to the high score list made the game a massive hit"). O paper acadêmico sobre highscoring como prática midiática ([Tandfonline, texto completo](https://www.tandfonline.com/doi/full/10.1080/23311983.2016.1210277)) documenta a intenção de design: "enable players to alternatingly compete against each other **via the machine** instead of just playing against the machine" — competição assíncrona local, exatamente o que uma web app estática consegue fazer sem backend [H].

Documentação oficial de plataforma [P] (não revisada por pares — tratar como prática industrial informada por dados proprietários):

- **Google Play Games** ([achievements](https://developer.android.com/games/pgs/achievements), [quality checklist](https://developer.android.com/games/pgs/quality)): mínimo de 10 conquistas ao longo da vida do jogo; **pelo menos 4 alcançáveis na primeira hora de jogo por qualquer jogador**; usar **conquistas incrementais com progresso visível**; pontos proporcionais ao tempo/habilidade exigidos; variedade de dificuldades; conquistas escondidas para surpresa; todas devem ser alcançáveis. Blog oficial de 2025 ([Android Developers](https://android-developers.googleblog.com/2025/06/get-ready-for-next-generation-gameplay-play-games-services.html)): "games that enable players to earn at least 5 achievements in the first 2 hours of gameplay are most successful in driving deeper engagement" — correlação de plataforma, não causalidade demonstrada.
- **Apple Game Center** ([WWDC20, Design for Game Center](https://developer.apple.com/videos/play/wwdc2020/10145/)): leaderboards devem "best represent the core mechanics of your game play" (um leaderboard por métrica central — distância, rally, precisão); o sistema oferece **leaderboards recorrentes com filtro por período** — o recorte temporal resolve o problema do topo inalcançável e cria ciclos novos de competição.

### 5.4 Maestria como motor — e seu custo de entrada

Convergem aqui: a máxima de Bushnell (§2.3) [H]; a competência como necessidade (§2.1) [EA]; a taxa de reengajamento via flow (§3.1) [EA]; e os objetivos de aprendizagem para habilidades em aquisição (§5.1) [AM]. A leitura para design [Inf]: a maestria precisa de (a) **camadas visíveis de habilidade** (o jogador deve conseguir *perceber* que melhorou — métricas de forma, não só score), (b) desafio que continua esticando à medida que a habilidade sobe (rampa), e (c) barreira de entrada baixa — Bushnell é uma frase de duas metades, e a primeira ("easy to learn") é a que faz a segunda possível. Num jogo de pose, "easy to learn" depende de calibração rápida e gestos tolerantes, não de tutorial longo.

---

## 6. Recompensas: o que sustenta e o que corrói

- **Deci, Koestner & Ryan (1999, *Psychological Bulletin* 125(6):627–668, [PDF](https://selfdeterminationtheory.org/wp-content/uploads/2014/04/1999_DeciKoestnerRyan_Meta.pdf))** [AM, 128 estudos]: recompensas tangíveis esperadas contingentes a engajar/completar/performar minam motivação intrínseca em livre escolha (d=−0,40, −0,36, −0,28 respectivamente). Em contraste, **feedback positivo aumentou** comportamento de livre escolha (d=+0,33) e interesse autorreportado (d=+0,31). Recompensas inesperadas não minam.
- **Lepper, Greene & Nisbett (1973, *JPSP* 28(1):129–137, [PDF](https://bingschool.stanford.edu/sites/bingschool/files/1973_lepperetal.pdf))** [EA de campo com crianças]: o experimento original do *overjustification* — crianças que desenhavam por prazer e passaram a esperar recompensa por isso perderam interesse intrínseco; as que receberam a **mesma recompensa sem esperá-la** não perderam nada.

**Regras de design derivadas** [Inf]: (1) feedback positivo sobre performance é a "recompensa" com melhor evidência — celebração informacional, não controle; (2) conquistas e marcos são seguros quando funcionam como **reconhecimento de algo feito por vontade própria** (inesperados ou informacionais), perigosos quando viram a *razão anunciada* de jogar ("jogue X partidas para ganhar Y" converte jogo em meio); (3) nunca amarrar recompensa contínua a métrica repetitiva de grind — é a combinação que a CET prevê corroer autonomia; (4) surpresas aleatórias positivas (easter eggs) são seguras motivacionalmente — mas ver §7 sobre variabilidade para o limite ético.

---

## 7. Variabilidade e novidade: engajamento saudável × a fronteira do jogo de azar

- Malone (1981/1982) [AC]: aleatoriedade correlacionada com popularidade — como fonte de incerteza de resultado e variedade de situações (§2.3).
- Moller et al. (2023, *Digital Health*, [PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC13165798/)) [AM, 232 intervenções com active video games]: os fatores propostos como promissores para engajamento longo em exergames são **conexão social, novidade persistente, narrativa e movimento rítmico com música**. A revisão guarda-chuva de 2025 ([Frontiers](https://www.frontiersin.org/journals/sports-and-active-living/articles/10.3389/fspor.2025.1706145/full)) [AM, 20 revisões] registra o problema complementar: apenas 23% das intervenções sustentaram efeitos pós-intervenção e nomeia o fenômeno de **"novelty decay"** — a novidade decai e o engajamento vai junto.
- A fronteira ética: **Zendle & Cairns (2018, *PLOS One*, [artigo](https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0206767))** [AC, n=7.422]: gasto em loot boxes (recompensas aleatórias pagas) associado à severidade de jogo problemático (η²=0,054), mais forte que outras compras in-game (η²=0,004); direção causal indeterminada. O mecanismo de reforço de razão variável é o mesmo do jogo de azar — é por isso que a recomendação de "varie as recompensas aleatoriamente" que circula na indústria precisa de um filtro ético estrito.

**Distinção operacional** [Inf]: a variabilidade saudável varia **conteúdo e situação** (padrões de obstáculos, modificadores de round, cenários, oponentes) — novidade informacional que sustenta curiosidade e incerteza de *resultado da habilidade*. A variabilidade predatória varia **recompensa extrínseca por tentativa** (o que você ganha ao abrir/girar) — incerteza de *prêmio*, desacoplada da habilidade. A primeira é o que Malone mediu; a segunda é o que Zendle mede. Num app sem monetização o risco é menor, mas a regra permanece: aleatoriedade no mundo, nunca no prêmio.

---

## 8. Competição, cooperação e comparação social

- **Tauer & Harackiewicz (2004, *JPSP* 86(6):849, [DOI](https://doi.org/10.1037/0022-3514.86.6.849))** [EA, arremessos livres de basquete em acampamento]: a condição de **competição intergrupal** (cooperação dentro do time + competição entre times) produziu mais diversão **e** melhor performance que competição pura ou cooperação pura — "competition and cooperation both have positive aspects and structuring recreational activities to include both can facilitate high levels of both". Feedback de vitória/derrota modera (perder repetidamente corrói).
- **Staiano, Abraham & Calvert (2012, [PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC3440152/))** [EA, adolescentes, exergame Wii, 6 meses]: jogadores **cooperativos** foram significativamente mais intrinsecamente motivados que competitivos (p=.034, η² parcial=0,366); no estudo de 20 semanas ([PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC3473097/)), só o grupo cooperativo perdeu peso significativamente. Em exergames — nosso domínio exato — a cooperação com um parceiro presente é a forma social com melhor evidência.
- **Landers, Bauer & Callan (2017, *Computers in Human Behavior* 71:508–515, [DOI](https://doi.org/10.1016/j.chb.2015.08.008))** [EA]: a mera **presença de um leaderboard** levou participantes a performar no nível de quem recebeu objetivos difíceis/impossíveis explícitos — jogadores miram implicitamente o topo; moderado por comprometimento com o objetivo. Leaderboards funcionam *porque* carregam objetivos (teoria de goal-setting operando por trás).

**Síntese** [Inf]: competição é ferramenta legítima quando (a) oponentes são próximos em habilidade (a compressão de habilidade do DDA de Robb & Zhang ajuda aqui) e (b) há camadas cooperativas ou autorreferenciadas. Sem backend, as formas implementáveis são: competição contra o próprio histórico (o adversário mais justo que existe — habilidade idêntica por construção), tabela local de iniciais para a família/visita (Asteroids), e "times" contra a máquina. O que evitar: comparação que expõe derrota repetida sem caminho de melhoria — é a receita documentada para perda de motivação.

---

## 9. "Uma partida a mais": a anatomia do replay saudável

O que a evidência sustenta sobre reengajamento voluntário, peça por peça:

1. **Flow gera vontade comportamental de reengajar** (Keller, Ringelhan & Blomann 2011, §3.1) [EA] — o driver mais profundo é a experiência, não o artifício.
2. **Proximidade de meta acelera esforço** (goal-gradient, §5.2) [EA de campo] — um jogador que termina a partida a 12 pontos do recorde pessoal tem a motivação de recomeçar *já carregada*; o design só precisa **mostrar essa distância com precisão e instantaneamente**.
3. **O vale pós-conquista é previsível** (post-reward resetting, §5.2) — exatamente quando se bate o recorde é que a próxima meta precisa já estar visível.
4. **Objetivos em múltiplas camadas simultâneas** (Malone, §2.3): se o jogador não pode almejar o recorde ainda, ainda há o streak de barreiras, a cadência-alvo, o rally mais longo — sempre existe um objetivo ao alcance *nesta* partida.
5. **Fricção de recomeço**: aqui a evidência acadêmica é escassa e a prática industrial domina [H] — o arcade de fliperama cobrava ficha (fricção máxima) e mesmo assim o loop de score sustentava replay; jogos modernos de plataforma (Super Meat Boy, Celeste) levaram o restart instantâneo (<1s) ao extremo como princípio de design citado pelos próprios desenvolvedores. Tratar como heurística forte: custo de implementação baixo, risco baixo, coerente com tudo o que é evidência sobre momentum motivacional.
6. **Rodadas curtas com final definido** [Inf a partir de §5.1+§2.2]: objetivos "proximais" são condição de flow; rounds de 1–3 minutos criam unidades completas de desafio com veredito — cada round é uma pergunta respondida ("consegui?"), e a pergunta seguinte está a um botão de distância. Rounds curtos também são a unidade de segurança física (§11).

O que o "uma partida a mais" saudável **não** usa: energia que recarrega com tempo, punição por parar, streaks diários que se perdem (agendamento — §10), nem jackpots aleatórios. A distinção final: o replay saudável termina cada sessão com o jogador **querendo voltar**; o predatório termina com o jogador **com medo de perder algo se não voltar**.

---

## 10. Os limites éticos: dark patterns, tempo de jogo e saúde

- **Zagal, Björk & Lewis (2013, FDG, [PDF](http://www.fdg2013.org/program/papers/paper06_zagal_etal.pdf))** — taxonomia primária de dark patterns em jogos, verificada no original: **temporais** (grinding — "repetitive and tedious tasks" para estender duração; playing by appointment — obrigar retorno em horário/sob penalidade), **monetários** (pay-to-skip, conteúdo pré-entregue bloqueado, rivalidades monetizadas, escassez artificial — "One Time Offer! You will NEVER see this offer again!"), **de capital social** (friend spam, esquemas de pirâmide social, impersonação). Teste de checagem oferecido pelos autores: o jogador consegue formar expectativa correta sobre quanto tempo o jogo exige? Ele sentiria que "perdeu tempo"?
- **Tempo de jogo × bem-estar**: Johannes, Vuorre & Przybylski (2021, *Royal Society Open Science* 8:202049, [artigo](https://royalsocietypublishing.org/rsos/article/8/2/202049/95851/Video-game-play-is-positively-correlated-with-well)) [AC com telemetria objetiva, Nintendo+EA]: correlação pequena e positiva entre tempo de jogo e bem-estar afetivo. O desenho mais forte veio depois — **Vuorre, Johannes, Magnusson & Przybylski (2022, RSOS 9:220411, [artigo](https://royalsocietypublishing.org/rsos/article/9/7/220411/96718/Time-spent-playing-video-games-is-unlikely-to))** [EA longitudinal, 38.935 jogadores, 7 publishers, 6 semanas]: "little to no evidence for a causal connection between game play and well-being. However, results suggested that **motivations play a role** in players' well-being" — efeito de +1h/dia no afeto [−0,09; 0,16] na escala SPANE de 13 pontos, indistinguível de zero. Lição dupla para o design ético: não há licença para maximizar tempo de sessão como objetivo (ele não entrega bem-estar), e não há pânico justificado com tempo moderado (ele não destrói bem-estar) — **a motivação é a variável de saúde**.
- **OMS, ICD-11 — gaming disorder** ([who.int](https://www.who.int/standards/classifications/frequently-asked-questions/gaming-disorder)): padrão caracterizado por controle prejudicado, prioridade crescente sobre outras atividades e continuação apesar de consequências negativas, com prejuízo funcional significativo por normalmente ≥12 meses. Verbatim e importante: "gaming disorder affects only a small proportion of people who engage in digital- or video-gaming activities". O critério nunca é tempo — é perda de controle com prejuízo. Nosso design deve tornar a **saída** tão frictionless quanto a entrada: rounds com final, pausa trivial, nada pendente que se perde.
- **Risco físico específico de exergames**: Mueller et al. (2011, CHI, "Designing Sports: A Framework for Exertion Games", [PDF](https://exertiongameslab.org/wp-content/uploads/2020/12/designing_sports_chi2011.pdf)) nomeiam o **"risk of exertion"**: "the vulnerability of the body to overexertion and injury as a result of the exertion activity" — corpos se machucam, e o design deve mapear ações de esforço a ações de jogo "that match players' abilities to the challenge ahead". Engajamento saudável num exergame inclui ativamente **não** incentivar esforço contínuo sem pausa.

---

## 11. Especificidades de exergames: duas balanças, não uma

- **Dual flow** (Sinclair, Hingston & Masek 2007, GRAPHITE, [Semantic Scholar](https://www.semanticscholar.org/paper/Considerations-for-the-design-of-exergames-Sinclair-Hingston/b94a25e8fb7988fa81249d7e70954faab6d7ce77); desenvolvido em trabalhos seguintes do grupo, [ex.](https://dl.acm.org/doi/pdf/10.1145/1746050.1746061)) [AT]: o exergame equilibra **duas** razões — atratividade (habilidade×desafio, o flow psicológico padrão) e efetividade (aptidão física×intensidade do exercício, o análogo fisiológico: intensidade muito acima da aptidão → falha/abandono; muito abaixo → sem benefício e sem engajamento). Consequência: a dificuldade de um exergame deve adaptar-se tanto ao erro de gameplay quanto à capacidade física — e intensidade alta sustentada demais é anti-engajamento e anti-saúde ao mesmo tempo.
- **Revisão de efeitos psicológicos** (Lee, Kim, Park & Peng 2017, *Cyberpsychology* 20(9):513–532, [DOI](https://doi.org/10.1089/cyber.2017.0183)) [AM, 45 estudos experimentais]: modalidade de feedback (auditivo, tátil) e modo de jogo (solo×grupo) se relacionam a enjoyment/imersão/flow em exergames — a camada social e o feedback multicanal são alavancas medidas especificamente neste gênero.
- **Exergames reduzem a percepção de esforço** mantendo intensidade moderada-vigorosa (revisão sistemática em *Journal of American College Health* 72(7), [T&F](https://www.tandfonline.com/doi/full/10.1080/07448481.2022.2103377)) [AM] — a distração/prazer é o mecanismo de adesão; o jogo literalmente torna o exercício mais fácil de sustentar, desde que o engajamento se mantenha. Daí a importância dos fatores anti-"novelty decay" de Moller et al. (§7): conexão social, novidade, narrativa, música rítmica.

---

## 12. Evidência × heurística — mapa de confiança

| Afirmação de design | Status |
|---|---|
| Autonomia/competência/relacionamento → diversão, vontade de rejogar, bem-estar | **[EA]** forte, replicado (Ryan et al. 2006) |
| Balanço desafio–habilidade causa flow; flow causa reengajamento | **[EA]** experimental (Keller & Bless 2008; Keller et al. 2011) |
| Feedback de progresso task-relevant causa flow | **[EA]** (Schaffer & Fang 2022) |
| Juice em dose média-alta > zero ou extrema | **[EA]** um estudo grande (Kao 2020, N=3.018) — aguarda replicação |
| Objetivos específicos-difíceis > "faça o melhor"; objetivo+feedback > objetivo | **[AM]** meta-análises, d=0,42–0,80 (Locke & Latham 2002) |
| Esforço acelera perto da meta; engajamento cai após a recompensa | **[EA de campo]** (Kivetz et al. 2006) |
| Recompensa tangível esperada corrói; feedback positivo e surpresa não | **[AM]** 128 estudos + **[EA]** (Deci et al. 1999; Lepper et al. 1973) |
| Cooperação+competição juntas > cada uma só; em exergames, coop > comp | **[EA]** (Tauer & Harackiewicz 2004; Staiano et al. 2012) |
| Leaderboard motiva como objetivo difícil implícito | **[EA]** um experimento (Landers et al. 2017) |
| DDA melhora performance; efeito em diversão/flow é misto; DDA invisível custa controle | **[EA]** convergente mas não unânime (Ang & Mitchell 2017; Robb & Zhang 2022) |
| Feedback frequente demais degrada aprendizagem motora | **[AT] canon questionado** — meta-análise 2022 não confirma; usar como cautela, não lei |
| Dual flow (intensidade física × aptidão) deve ser equilibrado | **[AT]** modelo influente, não testado diretamente |
| Controles intuitivos se associam a competência/autonomia percebidas | **[EA]** dentro de Ryan et al. 2006 (mediação é o modelo testado) |
| "Easy to learn, hard to master" / restart instantâneo / juice como regra geral | **[H]** heurística industrial com eco teórico, sem teste direto |
| Conquistas na 1ª hora e incrementais ajudam retenção | **[P]** guidelines de plataforma — plausíveis, sem acesso aos dados |
| Loot box / reforço variável monetizado se associa a jogo problemático | **[AC]** consistente em vários estudos (Zendle & Cairns 2018+) — evitar por precaução |

---

## 13. Aplicação ao Wii Web Sports Arena

Estado verificado no commit `ecd481e` (HEAD no momento da análise — atenção: trabalho de implementação paralelo pode já existir na árvore de trabalho): a corrida é um modo **infinito sem final** — score acumula `dt·speed·50` +100/−35 por barreira (`src/games/track/trackScore.ts:4-15`), spawn a cada ~26u em raia aleatória (`src/games/track/TrackGame.ts:139`), sem rounds, sem recordes, sem restart; o tênis é single-shot com ponto binário e oponente que não devolve (`src/games/tennis/TennisGame.ts:59-71`); não existe **nenhuma persistência** (sem `localStorage`), nenhuma progressão, nenhum marco, nenhum feedback de fim de sessão; já existe áudio procedural por evento (`src/games/audio.ts`, dispatch em `src/App.tsx:56-61`) — a infraestrutura de juice está meio montada. O redesign do tênis em `docs/design-tenis.md` (rally estilo Wii, direção por timing) torna várias recomendações abaixo ainda mais naturais.

Tudo aqui roda numa web app estática: `localStorage`/`IndexedDB` cobrem perfis, recordes, conquistas, fantasmas e histórico. Nada exige backend.

### 13.1 Fundações transversais (os dois jogos)

Ordenadas por razão evidência/custo:

1. **Estrutura de rounds com final + restart instantâneo** — a mudança mais fundamental. Round de corrida: distância ou tempo fixos (ex.: 400 m ou 90 s); game de tênis: melhor de 3. Fim de round com veredito claro, e **um botão/um gesto reinicia em <1 s, sem voltar a menu, sem recalibrar**. Evidência: objetivos proximais + goal-gradient + reengajamento-via-flow (§2.2, §3.1, §5.2, §9). Custo: baixo-médio (máquina de estados de sessão).
2. **Recordes pessoais persistentes + exibição da distância para o recorde em tempo real** — `localStorage` por perfil ("iniciais" estilo Asteroids). Durante o round, HUD mostra não só o score mas **"recorde: 2.340 · você: 1.980"**; ao passar, marca instantaneamente ("NOVO RECORDE"). Na tela de fim: "**faltaram 12 pontos**" ou "superou por 36 — próximo marco: 2.500". Evidência: goal-gradient + post-reward resetting + leaderboards-como-objetivos (§5.2, §8). Custo: baixo. *Esta é provavelmente a intervenção com melhor razão evidência/custo do projeto inteiro.*
3. **Tela de fim de round com feedback específico e acionável** — 3–5 números concretos da tarefa (distância, % barreiras limpas, cadência média e pico / pontos, rally máximo, qualidade média do contato) + **uma** dica de melhoria baseada na métrica mais fraca ("contatos tardios: inicie o swing antes"). Nunca avaliar a pessoa. Evidência: Shute (§4.3), feedback task-relevant (§4.1), objetivo+feedback (§5.1). Custo: baixo.
4. **Juice escalonado em dose média-alta** — intensificar o que já existe: som e efeito visual proporcionais à magnitude (passo < barreira limpa < streak de 3 < recorde), com clímax curto em marcos e **silêncio relativo no miolo**. Evitar extremo constante (U invertido, §4.2). Custo: baixo-médio (partículas/simples em Three.js + variações no `ProceduralAudio`).
5. **Rampa de dificuldade visível dentro do round, estilo Breakout/Space Invaders** — a cada N barreiras limpas (ou games ganhos), o jogo sobe um nível **anunciado** ("NÍVEL 2 — barreiras mais rápidas"): densidade/velocidade de barreiras na corrida, velocidade de devolução/alcance do oponente no tênis. Visibilidade preserva senso de controle (§3.2) e cria narrativa de maestria. Custo: baixo — os parâmetros já existem no código (spawn distance, velocidades).
6. **Conquistas incrementais com progresso visível** — 10–15 iniciais, ≥4 alcançáveis na primeira sessão ("primeiro salto", "primeira barreira limpa", "primeiro round completo", "primeiro rally de 5"), incrementais com barra ("50 barreiras limpas: 31/50"), pontos proporcionais à dificuldade, algumas escondidas/surpresa. Semanas depois, novos marcos com novo conteúdo. Evidência: goal-gradient + incremental progress [P, §5.3] + reconhecimento-informacional seguro (§6). Custo: baixo-médio. **Regra de ouro**: conquistas registram e celebram o que o jogador fez por vontade própria — nunca viram a razão anunciada de jogar (sem "jogue 30 min para ganhar X").
7. **Ghost do recorde pessoal** — gravar a série temporal de posição/ritmo do melhor round (amostras já existem a 60 Hz; comprimindo, cabe em poucos KB por round em `localStorage`) e replayar como corredor/oponente translúcido. É o leaderboard de Landers com o oponente perfeitamente calibrado por construção — e resolve autonomia (é você contra você). Custo: médio (playback + interpolação), evidência indireta mas convergente (§8). Prioridade pós-fundações.
8. **Tabela local de iniciais por perfil + recortes semanais** — competição assíncrona doméstica (Asteroids, §5.3); recorte semanal reinicia a disputa periodicamente (leaderboards recorrentes da Apple) e evita topo inalcançável. Custo: baixo.
9. **Escolhas agênticas de risco (active DDA)** — antes do round: "ritmo alvo: confortável / intenso / máximo" (também calibra intensidade física — dual flow, §11); no tênis, bolas arriscadas valem mais (linha vs centro já carrega risco/retorno natural). Evidência: Chen 2007 [AT] + Ang & Mitchell pDDA [EA] (§3.2). Custo: baixo.
10. **Higiene física de exergame** — rounds curtos como unidade natural de pausa; entre rounds, tela oferece "descansar" sem custo; jamais punir pausa nem premiar esforço contínuo extremo; aviso leve de espaço livre/aquecimento no onboarding. Evidência: risk of exertion (§10–11). Custo: trivial — e é diferenciador ético do gênero.

### 13.2 Corrida — mecânicas concretas

- **Rounds de 400 m** (ou 60–90 s): o fim da corrida infinita é a mudança estrutural nº1. O round tem largada (contagem com os pés já andando — sem tela morta), chegada, veredito.
- **Marcador fantasma do recorde na pista**: uma linha/placa lateral na posição z onde o recorde foi batido, aproximando-se durante o round — goal-gradient tornado literal, espacial. (Mais barato que o ghost completo e boa parte do efeito.)
- **Streak de barreiras com multiplicador visível**: +100 por barreira vira 100/150/225/… por saltos consecutivos limpos; o multiplicador e "faltam 2 para ×3" ficam no HUD. Errar reseta o multiplicador, **não** o score — penalidade suave, sem loss-framing agressivo ("no Flow breakers", Chen).
- **Alvo de cadência personalizado**: derivado do histórico (ex.: 85–95% da melhor cadência sustentada) com indicador de zona no HUD — implementa a balança fisiológica do dual flow usando o `cadenceSpm` que `gait.ts` já carrega. DDA físico transparente: o alvo sobe conforme o histórico melhora.
- **Variedade de conteúdo**: padrões de barreiras (raias alternadas, duplas, sequência rítmica) sorteados por segmento — incerteza de situação, nunca de prêmio (§7). Bônus barato: os padrões ensinam maestria (leitura à distância).
- **Feedback de forma em resumo**: se o salto raspa a barreira frequentemente, a dica de fim de round é "salte um pouco antes" — específico, na tarefa, em dose única (§4.3).

### 13.3 Tênis — mecânica concreta (sobre o redesign de `design-tenis.md`)

- **Rally como placar de segunda camada**: "rally mais longo: 14" persiste como recorde paralelo aos games — objetivos em múltiplos níveis simultâneos (Malone): quem não vence o game ainda disputa o rally.
- **Oponente com níveis nomeados e explícitos** ("Estreante → Clube → Profissional") com velocidade/alcance/placement subindo por faixa e **promoção anunciada** ao vencer; rebaixamento suave ou estável — nunca invisível (§3.2). Cada nível é um marco de progressão com conquista associada.
- **Match curto melhor-de-3 com revanche de um toque** — "REVANCHE" imediato no fim (o "uma partida a mais" na forma mais pura: ciclo completo de 2–3 minutos, recomeço sem fricção, adversário já calibrado).
- **Qualidade de contato como métrica de maestria visível**: o timing do swing (cedo/no ponto/tarde — já central no redesign) vira feedback imediato sutil por bola e estatística de fim de match ("% no ponto") — camada de maestria perceptível independente de ganhar (§5.4).
- **Modo cooperativo local opcional**: dois jogadores (câmera + teclado, ou dois perfis alternando) no mesmo time contra o oponente em dupla — a forma social com melhor evidência em exergames é cooperação (§8); num app estático é implementável com o segundo jogador no teclado. Prioridade baixa, mas é o único caminho local para a dimensão social real.
- **Sem punição por whiff de detector**: coerente com o princípio do próprio design doc — nenhum erro pode ser culpa invisível do sensor, porque erro injusto destrói competência percebida (§2.1). Isto é requisito de engajamento, não só de robustez.

### 13.4 O que NÃO fazer — checklist anti-dark-pattern para este projeto

Derivado de Zagal et al. (§10), Deci et al. (§6) e Zendle & Cairns (§7):

- ❌ Streaks diários ou qualquer mecânica que se perde por não jogar (playing by appointment + aversão à perda).
- ❌ Moedas/energia que limitam partidas ou recarregam com o tempo.
- ❌ Recompensas aleatórias por tentativa (caixas, giros, drops) — mesmo sem dinheiro real, o loop de reforço variável não é necessário e normaliza o padrão.
- ❌ Grind walls: progresso que exige repetição tediosa desacoplada de melhoria de habilidade.
- ❌ Rubber-banding/DDA invisível que nega agência ("o jogo decide por você sem dizer").
- ❌ Escassez artificial ou urgência fabricada ("só hoje!").
- ❌ Feedback sobre a pessoa ("você é lento") ou celebração de métricas de quantidade bruta de tempo jogado como conquista ("jogou 5 horas!") — quantidade de tempo não é a métrica de saúde nem de maestria (§10).
- ❌ Notificações/prompts para voltar — o jogo não tem o direito de chamar; o jogador volta porque quer.

### 13.5 Roteiro sugerido (razão evidência/custo)

1. **Rounds + restart instantâneo + recordes pessoais com distância-para-o-recorde** (§13.1: 1–3) — três intervenções baratas sustentadas pela evidência mais forte disponível (flow→reengajamento, goal-gradient, goal-setting+feedback).
2. **Juice escalonado + rampa de dificuldade visível** (4–5) — feedback e desafio, as outras duas condições de flow.
3. **Conquistas incrementais + tabela local de iniciais** (6, 8) — progressão longa e camada social assíncrona.
4. **Ghost do recorde, níveis de oponente, co-op** (7, 13.3) — aprofundamento conforme o redesign do tênis assentar.
5. Medir localmente: sessões por perfil, taxa de revanche imediata, distribuição de abandono por ponto do round — telemetria local anônima em `localStorage` para validar se o vale pós-conquista e a aceleração de goal-gradient aparecem como previsto [Inf].

---

## 14. Referências

Verificadas no original (texto completo quando aberto, abstract oficial caso contrário); links estáveis.

**Fundamentos motivacionais**
1. Ryan, R. M., Rigby, C. S., & Przybylski, A. (2006). The motivational pull of video games: A self-determination theory approach. *Motivation and Emotion* 30:347–363. [PDF](https://www.selfdeterminationtheory.org/SDT/documents/2006_RyanRigbyPrzybylski_MandE.pdf) · [DOI](https://doi.org/10.1007/s11031-006-9051-8)
2. Nakamura, J., & Csikszentmihalyi, M. (2002). The concept of flow. In *Handbook of Positive Psychology*. [PDF](https://nuovoeutile.it/wp-content/uploads/2015/12/2002-Flow.pdf)
3. Peifer, C. et al. (2022). A scoping review of flow research. *Frontiers in Psychology*. [texto completo](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2022.815665/full)
4. Malone, T. W. (1981). Toward a theory of intrinsically motivating instruction. *Cognitive Science* 5(4):333–369. [Wiley](https://onlinelibrary.wiley.com/doi/10.1207/s15516709cog0504_2)
5. Malone, T. W. (1982). Heuristics for designing enjoyable user interfaces: Lessons from computer games. [PDF](https://www.hcs64.com/files/Malone-Heuristiques.pdf)
6. Sweetser, P., & Wyeth, P. (2005). GameFlow: A model for evaluating player enjoyment in games. *Computers in Entertainment* 3(3). [PDF](https://svn.sable.mcgill.ca/sable/courses/COMP763/newpapers/sweetser-05-gameflow.pdf)

**Desafio e dificuldade adaptativa**
7. Keller, J., & Bless, H. (2008). Flow and regulatory compatibility. *PSPB* 34:196–209. [PubMed](https://pubmed.ncbi.nlm.nih.gov/18212330/)
8. Keller, J., Ringelhan, S., & Blomann, F. (2011). Does skills–demands compatibility result in intrinsic motivation? *Journal of Positive Psychology* 6(5):408–417. [T&F](https://www.tandfonline.com/doi/full/10.1080/17439760.2011.604041)
9. Hunicke, R., & Chapman, V. (2004). AI for dynamic difficulty adjustment in games. [PDF](https://users.cs.northwestern.edu/~hunicke/pubs/Hamlet.pdf)
10. Ang, D., & Mitchell, A. (2017). Comparing effects of dynamic difficulty adjustment systems on video game experience. *CHI PLAY '17*, 317–327. [ACM](https://dl.acm.org/doi/10.1145/3116595.3116623)
11. Robb, N., & Zhang, B. (2022). Performance-based dynamic difficulty adjustment and player experience in a 2D digital game. *Acta Ludologica* 5(1). [PDF](https://actaludologica.com/wp-content/uploads/2022/06/AL_2022-5-1_Study-1_Robb-Zhang.pdf)
12. Chen, J. (2007). Flow in games (and everything else). *Communications of the ACM* 50(4):31. [PDF](https://jenovachen.com/flowingames/p31-chen.pdf) · [tese MFA completa](http://www.jenovachen.com/flowingames/Flow_in_games_final.pdf)

**Feedback**
13. Schaffer, O., & Fang, X. (2022). The feedback loop of flow: Controlled experiment shows task-relevant feedback increases flow. *AIS THCI* 14(3):356–389. [artigo](https://aisel.aisnet.org/thci/vol14/iss3/4)
14. Kao, D. (2020). The effects of juiciness in an action RPG. *Entertainment Computing* 34:100359. [DOI](https://doi.org/10.1016/j.entcom.2020.100359) · [abstract UIUC](https://experts.illinois.edu/en/publications/the-effects-of-juiciness-in-an-action-rpg/)
15. Shute, V. J. (2008). Focus on formative feedback. *Review of Educational Research* 78(1). [DOI](https://journals.sagepub.com/doi/10.3102/0034654307313795)
16. Salmoni, A. W., Schmidt, R. A., & Walter, C. B. (1984). Knowledge of results and motor learning. *Psychological Bulletin* 95(3):355–386. [DOI](https://doi.org/10.1037/0033-2909.95.3.355)
17. Schmidt, R. A. et al. (1989). Summary knowledge of results for skill acquisition. [PubMed](https://pubmed.ncbi.nlm.nih.gov/2522520/)
18. Meta-análise (2022). Meta-analysis of the reduced relative feedback frequency effect on motor learning. *Psychology of Sport and Exercise*. [DOI](https://doi.org/10.1016/j.psychsport.2022.102165)

**Objetivos e progressão**
19. Locke, E. A., & Latham, G. P. (2002). Building a practically useful theory of goal setting and task motivation: A 35-year odyssey. *American Psychologist* 57(9):705–717. [PDF](https://goal-lab.psych.umn.edu/orgPsych/readings/5.%20Motivation/Locke%20%26%20Latham%20%282002%29.pdf)
20. Kivetz, R., Urminsky, O., & Zheng, Y. (2006). The goal-gradient hypothesis resurrected. *Journal of Marketing Research* XLIII:39–58. [PDF](https://business.columbia.edu/sites/default/files-efs/pubfiles/1200/goalgradient.pdf)
21. Google Play Games — Achievements: [design](https://developer.android.com/games/pgs/achievements) · [quality checklist](https://developer.android.com/games/pgs/quality) · [Level Up guidelines](https://developer.android.com/games/guidelines)
22. Apple — Design for Game Center, WWDC20. [vídeo/notas](https://developer.apple.com/videos/play/wwdc2020/10145/)

**Recompensas, variabilidade, competição**
23. Deci, E. L., Koestner, R., & Ryan, R. M. (1999). A meta-analytic review of experiments examining the effects of extrinsic rewards on intrinsic motivation. *Psychological Bulletin* 125(6):627–668. [PDF](https://selfdeterminationtheory.org/wp-content/uploads/2014/04/1999_DeciKoestnerRyan_Meta.pdf)
24. Lepper, M. R., Greene, D., & Nisbett, R. E. (1973). Undermining children's intrinsic interest with extrinsic reward. *JPSP* 28(1):129–137. [PDF](https://bingschool.stanford.edu/sites/bingschool/files/1973_lepperetal.pdf)
25. Tauer, J. M., & Harackiewicz, J. M. (2004). The effects of cooperation and competition on intrinsic motivation and performance. *JPSP* 86(6):849. [DOI](https://doi.org/10.1037/0022-3514.86.6.849)
26. Landers, R. N., Bauer, K. N., & Callan, R. C. (2017). Gamification of task performance with leaderboards. *Computers in Human Behavior* 71:508–515. [DOI](https://doi.org/10.1016/j.chb.2015.08.008)
27. Zendle, D., & Cairns, P. (2018). Video game loot boxes are linked to problem gambling. *PLOS One*. [artigo](https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0206767)

**Saúde, ética e bem-estar**
28. Zagal, J. P., Björk, S., & Lewis, C. (2013). Dark patterns in the design of games. *FDG 2013*. [PDF](http://www.fdg2013.org/program/papers/paper06_zagal_etal.pdf)
29. Johannes, N., Vuorre, M., & Przybylski, A. K. (2021). Video game play is positively correlated with well-being. *Royal Society Open Science* 8:202049. [artigo](https://royalsocietypublishing.org/rsos/article/8/2/202049/95851/Video-game-play-is-positively-correlated-with-well)
30. Vuorre, M., Johannes, N., Magnusson, K., & Przybylski, A. K. (2022). Time spent playing video games is unlikely to impact well-being. *RSOS* 9:220411. [artigo](https://royalsocietypublishing.org/rsos/article/9/7/220411/96718/Time-spent-playing-video-games-is-unlikely-to)
31. OMS — Gaming disorder, ICD-11 FAQ. [who.int](https://www.who.int/standards/classifications/frequently-asked-questions/gaming-disorder)

**Exergames**
32. Sinclair, J., Hingston, P., & Masek, M. (2007). Considerations for the design of exergames. *GRAPHITE 2007*. [registro](https://www.semanticscholar.org/paper/Considerations-for-the-design-of-exergames-Sinclair-Hingston/b94a25e8fb7988fa81249d7e70954faab6d7ce77)
33. Mueller, F. et al. (2011). Designing sports: A framework for exertion games. *CHI 2011*. [PDF](https://exertiongameslab.org/wp-content/uploads/2020/12/designing_sports_chi2011.pdf)
34. Lee, S., Kim, W., Park, T., & Peng, W. (2017). The psychological effects of playing exergames: A systematic review. *Cyberpsychology, Behavior, and Social Networking* 20(9):513–532. [DOI](https://doi.org/10.1089/cyber.2017.0183)
35. Staiano, A. E., Abraham, A. A., & Calvert, S. L. (2012). Motivating effects of cooperative exergame play for overweight and obese adolescents. [PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC3440152/) · estudo de 20 semanas: [PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC3473097/)
36. Moller, A. C., Sousa, C. V., Lee, K. J., Alon, D., & Lu, A. S. (2023). A comprehensive systematic review and content analysis of active video game intervention research. *Digital Health* 9. [PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC13165798/)
37. Exergaming for physical activity: A systematic review. *Journal of American College Health* 72(7). [T&F](https://www.tandfonline.com/doi/full/10.1080/07448481.2022.2103377)
38. Effectiveness of active video games for promoting physical activity: an umbrella review (2025). *Frontiers in Sports and Active Living*. [texto completo](https://www.frontiersin.org/journals/sports-and-active-living/articles/10.3389/fspor.2025.1706145/full)

**História do arcade (contexto)**
39. Guinness World Records — First videogame with a personalized high-score table (Asteroids, 1979). [GWR](https://www.guinnessworldrecords.com/world-records/first-video-game-to-include-a-personalized-high-score-table)
40. The Strong National Museum of Play — Asteroids. [museumofplay.org](https://www.museumofplay.org/games/asteroids/)
41. On the media practice of highscoring (2016). *Cogent Arts & Humanities*. [texto completo](https://www.tandfonline.com/doi/full/10.1080/23311983.2016.1210277)
42. Den of Geek — What was the first video game with high scores? [resenha histórica](https://www.denofgeek.com/games/first-video-game-high-score-invented-history/)
