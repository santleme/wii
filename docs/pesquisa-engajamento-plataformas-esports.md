# Pesquisa profunda — mecanismos de engajamento de plataformas (Meta) e de jogos/e-sports modernos, e sua tradução ética para um jogo web local

Data: 25 de novembro de 2026 · Branch: `main` pós-merge (`ecd481e`)
Escopo: o que plataformas de atenção (Facebook/Instagram/Meta Quest) e jogos/e-sports modernos (League of Legends, Dota 2, Fortnite, Nintendo Switch Sports, Duolingo, Strava, Wordle) fazem, comprovadamente, para engajar — e quais desses mecanismos um jogo web **estático, sem servidor, sem contas e sem monetização** pode adotar com benefício real ao jogador. Inclui análise ética explícita de dark patterns.

Relação com o doc irmão: `docs/pesquisa-engajamento-jogos.md` cobre a psicologia acadêmica do engajamento em arcade (flow, feedback, juiciness, recompensas intrínsecas, evidência experimental de DDA, dual flow de exergames) com rótulos de evidência. Este documento é complementar e **não repete** aquela análise: aqui o foco são os mecanismos concretos da indústria — ranking de feeds, streaks, matchmaking, ligas ranqueadas, battle passes, compartilhamento, replays, fantasmas e identidade — documentados nas fontes primárias das próprias empresas. A seção 4 usa os fundamentos psicológicos apenas na medida necessária para explicar por que cada mecanismo da indústria funciona; para o tratamento experimental aprofundado, ver o doc irmão.

Método: fontes primárias sempre que possível — documentação oficial de plataforma (developers.meta.com, support.riotgames.com, transparency.meta.com), blogs de engenharia e posts de design oficiais (about.fb.com, about.instagram.com, leagueoflegends.com/dev, blog.duolingo.com, nintendo.com), papers dos próprios autores (TrueSkill/Microsoft Research, EOMM/EA, Hunicke, Ryan & Deci, Locke & Latham, Kahneman & Tversky, Festinger, Ferster & Skinner), documentos regulatórios (FTC, CMA) e manuais oficiais de jogos (Mario Kart). Todos os links deste documento foram verificados individualmente (HTTP 200) na data acima; onde a fonte original saiu do ar, usa-se cópia arquivada com aviso. Fontes secundárias (imprensa) são usadas só para fatos factuais datados e marcadas como tal.

---

## 1. Resumo executivo

1. **Os mecanismos de engajamento mais potentes documentados não são "truques de feed" — são estruturas de motivação**: metas específicas com feedback imediato ([Locke & Latham 2002](https://med.stanford.edu/content/dam/sm/s-spire/documents/PD.locke-and-latham-retrospective%5FPaper.pdf)), desafio calibrado à habilidade ([flow, Nakamura & Csikszentmihalyi](https://nuovoeutile.it/wp-content/uploads/2015/12/2002-Flow.pdf)), senso de competência/autonomia/relação ([Ryan & Deci 2000](http://selfdeterminationtheory.org/SDT/documents/2000_RyanDeci_SDT.pdf)) e progresso visível em direção a um objetivo ([Kivetz et al. 2006](https://business.columbia.edu/sites/default/files-efs/pubfiles/1200/goalgradient.pdf), [Nunes & Drèze 2006](https://students.marshall.usc.edu/sites/default/files/jnunes/intellcont/Endowed%20Progress%20Effect-1.pdf)). Todos implementáveis localmente, sem servidor.
2. **A espinha dorsal do engajamento saudável em jogos é a partida justa**: TrueSkill modela habilidade como distribuição com incerteza explícita ([paper original, Microsoft Research](https://proceedings.neurips.cc/paper_files/paper/2006/file/f44ee263952e65b3610b8ba51229d1f9-Paper.pdf)); Riot mira 50±1% de win rate esperado entre times ([/dev: Matchmaking Real Talk](https://www.leagueoflegends.com/en-us/news/dev/dev-matchmaking-real-talk/)). Num jogo single-player local, o equivalente é **dificuldade adaptativa honesta** — o "matchmaking" é contra si mesmo.
3. **Streaks funcionam e há dados públicos**: usuários com 7 dias de streak têm 2,4× mais chance de voltar no dia seguinte ([Duolingo](https://blog.duolingo.com/improving-the-streak/)). Mas a versão baseada em medo de perder é a mesma mecânica que o Snapchat **monetiza** — restaurar um streak morto custa dinheiro real ([suporte oficial Snap](https://help.snapchat.com/hc/en-us/articles/13086861638676-How-much-does-it-cost-to-restore-a-Streak)). A linha ética passa exatamente aí: a mecânica é neutra, o *framing de perda* é a manipulação.
4. **A própria Meta documenta os dois lados**: seu ranking otimiza explicitamente tempo de sessão (uma das predições do feed do Instagram é a probabilidade de o primeiro post "manter você gastando tempo no Feed durante esta sessão" — [system card oficial](https://transparency.meta.com/features/explaining-ranking/ig-feed/)), mas a mesma empresa publicou que uso passivo piora o humor enquanto interação ativa com amigos próximos melhora bem-estar ([Hard Questions, 2017](https://about.fb.com/news/2017/12/hard-questions-is-spending-time-on-social-media-bad-for-us/)) — e aceitou **perder 50 milhões de horas/dia** de tempo de uso ao re-ranquear o feed para "interações sociais significativas" ([testemunho da Meta ao Parlamento do Reino Unido](https://committees.parliament.uk/writtenevidence/132928/html/)).
5. **O antiexemplo acadêmico mais importante é da indústria de jogos**: o paper EOMM (autores da EA, WWW 2017) propõe matchmaking que maximiza engajamento/minimiza churn em vez de justiça, tratando partida equilibrada como caso especial ([arXiv:1702.06820](https://arxiv.org/abs/1702.06820)). É o norte negativo desta pesquisa: otimizar retenção contra o interesse do jogador.
6. **Os mecanismos mais valiosos para este projeto são os mais antigos e mais simples**: o fantasma de corrida existe desde Mario Kart 64 (1997) — "um personagem semivisível pilotará exatamente da mesma maneira que os dados gravados" ([manual oficial N64](https://www.nintendo.com/eu/media/downloads/games_8/emanuals/nintendo_8/Manual_Nintendo64_MarioKart64_EN.pdf)); o compartilhamento textual de resultado do Wordle foi inventado por uma jogadora e viralizou sem nenhum servidor social ([entrevista de Wardle ao TechCrunch](https://techcrunch.com/2022/01/12/josh-wardle-interview-wordle/)); e a Nintendo desenha ranks com **botão de pausa** para ninguém se sentir pressionado ([Ask the Developer Vol. 5](https://www.nintendo.com/us/whatsnew/ask-the-developer-vol-5-nintendo-switch-sports-part-4/)).
7. **Este projeto está em posição privilegiada**: passo fixo de 1/60 s (`GameLoop.ts`), eventos de input com timestamps (`SportActionEvent.timestampMs`) e zero monetização significam que replay determinístico, fantasma, share cards e ranks honestos são baratos — e que quase nenhuma das pressões que geram dark patterns existe aqui. Recomendações priorizadas na seção 7.

---

## 2. O que as plataformas de atenção fazem — evidência primária

### 2.1 O feed é uma máquina de predição de comportamento

O system card oficial do Instagram Feed ([transparency.meta.com](https://transparency.meta.com/features/explaining-ranking/ig-feed/)) descreve o funil em quatro estágios: coletar posts candidatos → um modelo leve seleciona ~700 → modelos fazem **predições de comportamento** → score e ordenação de ~500. As predições listadas pela própria Meta incluem:

- probabilidade de curtir/comentar/salvar/compartilhar por DM;
- **tempo que você provavelmente passará no post** e no perfil do autor;
- probabilidade de pular o post;
- probabilidade de ligar o som de um vídeo;
- **"a probabilidade de o primeiro post que você vê manter você gastando tempo no Feed durante esta sessão"** — ou seja, o sistema otimiza explicitamente *comprimento de sessão*, não só relevância do item.

Mosseri detalhou os sinais em 2021 no blog oficial ([about.instagram.com](https://about.instagram.com/blog/announcements/shedding-more-light-on-how-instagram-works)): informação sobre o post (incluindo popularidade — quantas pessoas curtiram), sobre quem postou, sua atividade e seu histórico de interação. O mesmo post admite que "a maioria das pessoas olha menos da metade do seu Feed" — a ordenação decide o que é visto.

**Princípio extraível**: feedback de comportamento em loop fechado (medir o que o usuário faz e ajustar o que lhe é apresentado) é o motor de personalização. Num jogo local, o análogo honesto é medir desempenho e ajustar dificuldade/conteúdo — com a diferença crucial de que o objetivo é a experiência do jogador, não o tempo de sessão.

### 2.2 Métricas públicas de validação social — e o experimento reverso

A contagem pública de likes é uma máquina de comparação social ([Festinger 1954](https://doi.org/10.1177/001872675400700202): existe um drive universal de avaliar as próprias habilidades por comparação quando não há medida objetiva). Em 2019 o próprio Instagram testou **esconder** contagens de likes em 7+ países e depois nos EUA, com declaração oficial de Mosseri: "a ideia é despressurizar o Instagram, torná-lo menos uma competição" e reduzir ansiedade e comparação social (cobertura factual: [NPR](https://www.npr.org/2019/11/09/777906177/instagram-will-test-hiding-likes-on-some-u-s-accounts-starting-next-week), [TechCrunch](https://techcrunch.com/2019/11/08/instagram-hide-likes-us/)). Hoje esconder likes é opção permanente para todos, conforme a própria Meta ([meta.com/safety](https://www.meta.com/safety/communities/youth/wellbeing/)).

**Princípio extraível**: métricas públicas de aprovação geram engajamento *e* pressão. Numa versão sem servidor não há audiência — mas a lição é que **comparação consigo mesmo** (personal records) carrega a parte motivadora sem a parte tóxica. É exatamente o que Strava e Apple fazem (seção 3.6).

### 2.3 Streaks sociais — e a monetização da aversão à perda

O Snapchat institucionalizou o streak: emoji de fogo + contador de dias quando duas pessoas trocam snaps diários, e emoji de ampulheta quando o streak está prestes a expirar ([suporte oficial](https://help.snapchat.com/hc/en-us/articles/7012394193684-How-do-Streaks-work-and-when-do-they-expire)). O mecanismo é reforço por manutenção de cadeia — e a perda é suficientemente dolorosa que o Snap **vende restaurações**: uma grátis por usuário, depois preço variável por país; assinantes Snapchat+ ganham uma restauração gratuita por mês que expira se não for usada ([suporte oficial](https://help.snapchat.com/hc/en-us/articles/13086861638676-How-much-does-it-cost-to-restore-a-Streak)).

Esse é o exemplo mais limpo da indústria de **loss aversion monetizada**: a plataforma cria um ativo psicológico (a cadeia de dias), ameaça destruí-lo e cobra pelo resgate. A base experimental é a teoria dos prospectos — "losses loom larger than gains" ([Kahneman & Tversky 1979, Econometrica](https://doi.org/10.2307/1914185)).

### 2.4 Notificações, reengajamento e o que a própria Meta admite

O post "Hard Questions" da equipe de pesquisa do Facebook (2017, [about.fb.com](https://about.fb.com/news/2017/12/hard-questions-is-spending-time-on-social-media-bad-for-us/)) é raro por sua franqueza: uso **passivo** (scroll sem interação) está associado a piora de humor — incluindo experimento com randomização da Universidade de Michigan citado no post — e a hipótese causal apontada é a **comparação social negativa** com posts curados dos outros; uso **ativo** com amigos próximos (mensagens, comentários um-a-um) está associado a melhoras em suporte social, depressão e solidão. "Simplesmente transmitir atualizações de status não bastava."

Em 2018 o Facebook mudou o objetivo do ranking para "interações sociais significativas" ([post oficial de Mosseri](https://about.fb.com/news/2018/01/news-feed-fyi-bringing-people-closer-together/)). O custo, admitido pela própria Meta em testemunho ao Parlamento britânico: **"a mudança levou a uma redução de 50 milhões de horas por dia de tempo gasto no Facebook"** ([written evidence, UK Parliament](https://committees.parliament.uk/writtenevidence/132928/html/)). Ou seja: a empresa sabe medir o trade-off entre bem-estar e tempo de uso — e tempo de uso é o que a otimização padrão maximiza quando ninguém a impede.

Outros fatos oficiais relevantes:

- A Meta treinou um modelo de ML para **demoter** posts que mendigam engajamento ("CURTA se você é de Áries!") — ela mesma classifica engajamento artificialmente inflado como spam contrário a autenticidade ([News Feed FYI: Fighting Engagement Bait, 2017](https://about.fb.com/news/2017/12/news-feed-fyi-fighting-engagement-bait/)).
- Sob pressão regulatória, Instagram lançou painel de tempo de uso, lembrete diário, "You're all caught up" e **Take a Break** (lembrete para fechar o app após 10/20/30 minutos) — catalogados na página oficial de bem-estar ([meta.com/safety](https://www.meta.com/safety/communities/youth/wellbeing/)) e no [testemunho de Mosseri ao Senado dos EUA](https://www.commerce.senate.gov/wp-content/uploads/media/doc/Mosseri%20Testimony.pdf). São features anti-engajamento que existem porque o default era reconhecidamente nocivo.

### 2.5 Meta Quest: achievements de plataforma e fitness quantificado

A documentação de desenvolvedor do Meta Quest é uma fonte primária rica sobre design de achievements ([developers.meta.com](https://developers.meta.com/vr/documentation/unity/ps-achievements/)):

- **Três tipos de achievement**: *simple* (tudo-ou-nada, um evento), *count* (contador até um alvo, ex.: 10 zumbis), *bitfield* (conjunto de bits, ex.: visitar 5 de 6 locais) — um vocabulário pronto e suficiente para qualquer sistema de conquistas.
- **A plataforma exibe toast e toca som** quando o achievement é desbloqueado — a celebração é tratada como parte do mecanismo, não detalhe cosmético.
- Achievements aparecem no **Meta Quest Home** — progresso vira parte da identidade persistente do jogador fora do jogo.
- Existem achievements **secretos** (título/descrição/ícone ocultos até desbloquear) — surpresa como recompensa de exploração.
- Política *client-authoritative* vs *server-authoritative* existe porque trapaça em conquistas é um problema real quando há ranking entre jogadores. Num jogo local single-player, esse problema não existe — mais um custo que desaparece.

O Oculus Move era o painel de fitness da plataforma: **metas diárias de calorias e minutos** ativos em VR, agregadas entre apps, com achievements e sync para Apple Health/Health Connect ([posts oficiais](https://www.meta.com/blog/oculus-quest-platform-updates-oculus-link-exits-beta-introducing-oculus-move-and-more/) — nota: o Move foi descontinuado em 31/03/2025, segundo aviso nos próprios posts). Lição dupla para este projeto: (1) minutos ativos + metas diárias são a métrica de engajamento correta para um jogo de movimento — não cliques; (2) features de plataforma morrem — dados de progressão devem pertencer ao usuário, no dispositivo dele.

---

## 3. O que jogos e e-sports modernos fazem — evidência primária

### 3.1 Rating e matchmaking por justiça: a partida equilibrada como produto

**TrueSkill** (Herbrich, Minka, Graepel, Microsoft Research, NIPS 2006 — [paper](https://proceedings.neurips.cc/paper_files/paper/2006/file/f44ee263952e65b3610b8ba51229d1f9-Paper.pdf), [página do projeto](https://www.microsoft.com/en-us/research/project/trueskill-ranking-system/)): generalização bayesiana do Elo que modela habilidade como distribuição gaussiana — média **e incerteza explícita**. Contas novas têm alta incerteza e convergem rápido; o sistema infere habilidade individual a partir de resultados de equipe. O motivo declarado no abstract: partidas entre jogadores de habilidade parecida são "enjoyable, fair and exciting".

**Dota 2** — o post oficial de dezembro/2013 da Valve ([blog.dota2.com](https://blog.dota2.com/2013/12/matchmaking/)) é o documento de matchmaking mais transparente já publicado por uma grande empresa:

- vitória/derrota é o critério principal, mas desempenho individual pesa **quando a incerteza é alta** — é possível subir de MMR numa derrota no início;
- a Valve **publicou a distribuição de MMR da população** (percentil 50 = 2250, 90% = 3200, 99% = 4100);
- os critérios de qualidade de partida são listados explicitamente: times balanceados, menor spread de habilidade intra-time, experiência parecida, melhor jogador espelhado, mesmo idioma, tempo de fila aceitável — e o sistema pontua partidas candidatas por esses critérios;
- o blog afirma que o sistema não força taxa de vitória individual nem detecta/quebra sequências de vitórias/derrotas — a justiça é no pareamento, não na manipulação de resultados.

**League of Legends** — o /dev: Matchmaking Real Talk (Riot, 2018, [link](https://www.leagueoflegends.com/en-us/news/dev/dev-matchmaking-real-talk/)) afirma que a maioria dos times é formada com win rate esperado de **50±1%**, e explica por que o MMR é escondido atrás de uma camada visível (LP/divisões): usar o MMR como única marca de conquista "puniria metade da base de jogadores, cujo MMR cai ao longo da temporada — mesmo estando melhorando, porque todos os outros também estão". Ou seja: **a Riot separa deliberadamente a medida de habilidade (invisível, para pareamento) da medida de conquista (visível, para motivação)** — porque uma métrica que pode regredir indefinidamente é desmotivadora para metade da população. Posts recentes ([/dev 2024](https://www.leagueoflegends.com/en-us/news/dev/dev-matchmaking-in-2024/), [/dev Ranked 2026](https://www.leagueoflegends.com/en-us/news/dev/dev-ranked-2026/)) mostram re-calibração contínua da distribuição e um "climb indicator" para quando o rank visível atrasa o MMR — a transparência sobre o sistema é tratada como ferramenta de confiança.

### 3.2 O contraexemplo: matchmaking otimizado para engajamento (EOMM)

O paper **EOMM: An Engagement Optimized Matchmaking Framework** (Chen et al., vários autores da Electronic Arts, WWW 2017 — [arXiv](https://arxiv.org/abs/1702.06820), [proceedings ACM](https://dl.acm.org/doi/10.1145/3038912.3052559)) argumenta que o objetivo justiça ("partidas equilibradas são melhores") é subótimo para engajamento e propõe parear jogadores minimizando **risco de churn** predito por modelo, demonstrando ganho em simulação sobre dados reais de um jogo da EA. O paper prova que matchmaking por habilidade igual é caso especial do framework sob uma suposição simplificada.

EOMM é importante como **marco do que não fazer** (detalhado na seção 5): a função objetivo deixa de ser a qualidade da partida e passa a ser a retenção — o jogador vira meio, não fim. Note que a premissa empírica é frágil (os autores reconhecem que é simulação, não A/B ao vivo), mas o paper existe, foi publicado em venue de prestígio e articula exatamente a lógica que a comunidade de jogadores suspeita em "engagement-based matchmaking".

### 3.3 Ranks visíveis e a gestão da frustração: a solução da Nintendo

A série **Ask the Developer** sobre Nintendo Switch Sports ([Parte 4](https://www.nintendo.com/us/whatsnew/ask-the-developer-vol-5-nintendo-switch-sports-part-4/)) é a fonte primária mais instrutiva desta pesquisa para design ético de competição:

- **"Você ganha pontos independentemente de vencer ou perder"** — pontos trocáveis por itens cosméticos; a frustração da derrota é compensada por progresso garantido. Decisão consciente desde Wii Sports 2006: "é frustrante perder… não queremos que iniciantes sintam 'chega para mim'".
- **A Pro League só aparece depois**: jogadores são "convidados" à liga ranqueada por esporte quando já se acostumaram com o jogo — "achamos que algumas pessoas ficariam nervosas se vissem a Pro League desde o início".
- **"Pause Pro"**: opção de pausar a liga ranqueada — "sempre que há vencedores, há igual número de pessoas que perdem e se frustram. Para evitar que jogadores se sintam pressionados a vencer, criamos a opção de pausar a Pro League e descansar. Jogar com outros deveria ser inerentemente divertido."
- Até o menu evita a palavra "online" porque "algumas pessoas ficariam com medo de selecionar" — redução de atrito emocional, não só de cliques.
- A escada foi estendida pós-lançamento com ranks S e ∞ ([notas de update oficiais](https://en-americas-support.nintendo.com/app/answers/detail/a_id/58598/~/how-to-update-nintendo-switch-sports)) — sempre há um próximo degrau para o topo da distribuição.

### 3.4 Progressão e recompensa: XP, battle pass, achievements

O **Battle Pass do Fortnite** é o arquétipo da progressão sazonal: recompensas cosméticas em ~10 páginas desbloqueadas por XP de qualquer modo; níveis adicionais podem ser **comprados** (150 V-Bucks/nível); e — o ponto eticamente relevante — **"recompensas de um Battle Pass só podem ser obtidas naquela temporada"** ([página oficial de suporte Epic](https://www.epicgames.com/help/en-US/c-Category_Fortnite/c-Fortnite_Gameplay/what-is-the-battle-pass-where-can-i-learn-more-a000084706)), com a ressalva posterior de que itens podem reaparecer na loja após 18+ meses. Progressão + expiração + pay-to-skip: o passe combina goal-gradient (seção 4.4) com escassez artificial e FOMO — a parte de progressão é boa design de motivação; a parte de expiração é pressão artificial sobre um bem digital sem custo marginal.

O vocabulário de achievements do Meta Quest (seção 2.5) — simple/count/bitfield, toast+som, vitrine persistente — cobre o resto do espaço de design.

### 3.5 Metas diárias e streaks com dados medidos: o laboratório do Duolingo

O blog do Duolingo é a melhor fonte pública de dados de retenção por gamificação:

- Usuários que chegam a **7 dias de streak têm 2,4× mais probabilidade de continuar no dia seguinte** que usuários sem streak ([Improving the Streak](https://blog.duolingo.com/improving-the-streak/)).
- Achado de design: exigir a meta diária completa para manter o streak fazia usuários com metas ambiciosas perderem streaks *mesmo usando o app todo dia* — "estabelecer uma meta parecia ser uma barreira a formar um hábito diário". Solução: **desacoplar** — uma lição por dia mantém o streak, a meta é acompanhada separada. Lição: a barra do hábito deve ser baixa; a barra da ambição, separada.
- **Streak Wager** (apostar moeda virtual num streak de 7 dias, dobrando se completar): +14% de retenção D7 no A/B test ([post oficial](https://blog.duolingo.com/how-streaks-keep-duolingo-learners-committed-to-their-language-goals/)) — compromisso explícito e skin-in-the-game aumentam retorno.
- **Weekend Amulet**: o uso cai 5-10% nos fins de semana; o item protege o streak no fim de semana — admissão explícita de que "perder um streak pode ser muito desencorajador" (mesmo post).
- **Friend Streaks**: streaks compartilhados com até 5 amigos aumentam em 22% a probabilidade de completar a lição diária — "é como estudar ao lado de um amigo na biblioteca" ([post oficial](https://blog.duolingo.com/product-lessons-friend-streak/)). Co-presença assíncrona sem interação obrigatória.
- Milestones viraram **celebração explícita**: o Duo vira uma fênix de fogo em dias-marco, após pesquisa mostrar que a metáfora da chama não era universal ([post de design](https://blog.duolingo.com/streak-milestone-design-animation/)).

### 3.6 Auto-competição quantificada: Strava e Apple como modelos de referência

**Strava** ([Central de Ajuda](https://support.strava.com/en-us/articles/15402042-what-s-a-segment)): segments transformam qualquer trecho de percurso em leaderboard; coroas KOM/QOM para o primeiro, troféus para top-10, medalhas de PR; **Best Efforts** registra melhores marcas da vida inteira e top-5 por ano em distâncias/elevação/potência padronizadas ([página oficial](https://support.strava.com/en-us/articles/15401645-how-do-best-efforts-work-for-cycling-on-strava)); "matched activities" compara automaticamente a performance de hoje com performances passadas na mesma rota. O engajamento do Strava é essencialmente **auto-comparação arquivada** — o arquivo histórico é o produto.

**Apple Watch Activity Rings** ([página oficial](https://www.apple.com/watch/close-your-rings/)): três anéis diários (Move/Exercise/Stand) com metas pessoais ajustáveis; o relógio **sugere nova meta toda semana baseada na performance anterior** — meta dinâmica personalizada, exatamente o que Locke & Latham prescreveriam. E o detalhe eticamente mais interessante: é possível **pausar os anéis por até 90 dias sem quebrar o streak de prêmios** ([Apple Support](https://support.apple.com/guide/watch/adjust-your-activity-ring-goals-apd29b30023c/watchos)) — a Apple integrou o direito de adoecer/viajar/descansar na mecânica de cadeia. (O dia global "Close Your Rings" com prêmio de edição limitada, por outro lado, é escassez artificial leve — [newsroom Apple](https://www.apple.com/newsroom/2025/04/get-active-with-apple-watch/).)

### 3.7 Compartilhamento assíncrono de resultado: o caso Wordle

Wordle é a prova de que mecanismos de compartilhamento não precisam de servidor social:

- **Um puzzle por dia, o mesmo para todo mundo** — na entrevista ao TechCrunch Wardle afirma que se cada pessoa tivesse uma palavra diferente "não teria pegado": "é algo sobre ser um só puzzle, e todo mundo resolvendo-o" ([entrevista](https://techcrunch.com/2022/01/12/josh-wardle-interview-wordle/)). A escassez aqui *limita* o consumo — o oposto do infinite scroll — e cria um assunto comum diário.
- **A grade de emoji** foi inventada por uma jogadora da Nova Zelândia que digitava manualmente seus resultados no Twitter; Wardle a integrou ao app — "obviamente teve um impacto enorme" (mesma entrevista). O formato compartilha o *padrão da jornada* sem spoiler da resposta, cabe num tweet e é texto puro copiável.
- A palestra de Wardle no GDC chama-se **"Doing the Opposite of What You're Meant To"** ([GDC Vault](https://gdcvault.com/play/1027882/-Wordle-Doing-the-Opposite)) — sem anúncios, sem notificações, sem mecânicas de retenção; viralizou por compartilhamento genuíno entre famílias.

### 3.8 Replay, highlights e fantasma: re-experienciar a performance

**League of Legends** tem replay completo: download do `.rofl` na tela de fim de jogo ou histórico, últimas 20 partidas, expira a cada patch (o formato é acoplado à versão do jogo), e ferramenta embutida de gravação de **highlights em .webm** para compartilhar ([FAQ oficial Riot](https://support.riotgames.com/en-us/league-of-legends/gameplay/replays-faq-pro-tips)). Duas lições de engenharia: replay gravado como **dados de simulação** (inputs + seed re-simulados) é radicalmente menor que vídeo da mesma partida; e a expiração por patch é o preço de acoplar o formato à build — um formato versionado próprio, com migração, evita isso.

**O fantasma é anterior à internet**: o manual do Mario Kart 64 (Nintendo, 1997, [PDF oficial](https://www.nintendo.com/eu/media/downloads/games_8/emanuals/nintendo_8/Manual_Nintendo64_MarioKart64_EN.pdf)) já descrevia: o ghost é "a gravação do melhor tempo da pista"; "um personagem semivisível pilotará exatamente da mesma maneira que os dados gravados. **Com este ghost como referência, marcar o melhor tempo deveria ser fácil**". Mario Kart Wii estendeu para download/upload de ghosts de outros jogadores ([manual oficial Wii](https://csassets.nintendo.com/noaext/image/private/t_KA_PDF/Wii_Mario_Kart?_a=DATAg1AAZAA0)). O fantasma é a auto-comparação *tornada visível em tempo real dentro do jogo* — você não lê que foi mais lento, você **vê** seu eu passado te ultrapassar.

### 3.9 Identidade e celebração: Mii, toasts e o porquê do corpo ser o controle

O **Iwata Asks de Wii Sports** ([transcrição oficial Nintendo](https://www.nintendo.com/en-gb/Iwata-Asks/Iwata-Asks-Wii/Iwata-Asks-Wii-Sports/2-A-Question-of-Realism/2-A-Question-of-Realism-217824.html)) documenta as decisões que fizeram o jogo atravessar gerações:

- **Representação pessoal**: o conceito central era "algo no jogo que representasse o jogador ou sua família"; cogitaram fotos de câmera digital coladas no rosto do personagem e descartaram pelo atrito — o Mii nasceu da exigência de que criar o avatar fosse em si divertido.
- **Profundidade pela variação analógica**: no tênis, "é impossível acertar a mesma tacada duas vezes… se você acertar a bola 100 vezes, a ação será refletida na tela de 100 maneiras diferentes" — a riqueza do input físico *é* o conteúdo do jogo ([Iwata Asks Wii Sports, capítulo 4 — significativamente intitulado "Fun to Watch as Well as Play"](https://www.nintendo.com/en-gb/Iwata-Asks/Iwata-Asks-Wii/Iwata-Asks-Wii-Sports/4-Fun-to-Watch-as-Well-as-Play/4-Fun-to-Watch-as-Well-as-Play-217921.html)).
- **Miis na plateia**: personagens da família aparecem nas arquibancadas — presença social ambiental mesmo quando se joga sozinho ([Iwata Asks Wii Channels](https://www.nintendo.com/en-gb/Iwata-Asks/Iwata-Asks-Wii/Iwata-Asks-Wii-Channels/4-Aiming-For-Worldwide-Mii-Communication/4-Aiming-For-Worldwide-Mii-Communication-213650.html)).

Somado ao toast+som da plataforma Quest (2.5) e às animações de milestone do Duolingo (3.5), o padrão é consistente: **conquista sem celebração é subaproveitada** — o momento do desbloqueio é a recompensa, e a recompensa precisa ser *sentida* (visual + som + pausa dramática), não apenas registrada.

---

## 4. Por que funciona — fundamentos psicológicos primários

### 4.1 Autodeterminação: a motivação que não precisa de prêmio

Ryan & Deci (2000, *American Psychologist* — [PDF dos autores](http://selfdeterminationtheory.org/SDT/documents/2000_RyanDeci_SDT.pdf)): três necessidades psicológicas inatas — **competência** (sentir-se eficaz), **autonomia** (escolher a própria ação), **relação** (conexão com outros) — quando satisfeitas produzem motivação intrínseca e bem-estar; quando frustradas, produzem alienação. O paper também revê a evidência de que **recompensas extrínsecas tangíveis podem minar a motivação intrínseca** de atividades interessantes quando percebidas como controladoras — a razão pela qual um sistema de recompensas mal desenhado pode *matar* a graça de um jogo que já era divertido.

Mapeamento direto para design: feedback de competência (estou melhorando?), escolha de autonomia (eu escolhi esta meta?) e relação (jogo/comparo com pessoas?). Um jogo de movimento corporal tem uma quarta fonte que apps de feed não têm: **o corpo** — ver seção 4.8.

### 4.2 Flow: o canal entre tédio e ansiedade

Nakamura & Csikszentmihalyi, "The Concept of Flow" (*Handbook of Positive Psychology*, 2002 — [PDF do capítulo](https://nuovoeutile.it/wp-content/uploads/2015/12/2002-Flow.pdf)): a experiência ótima exige **equilíbrio entre desafio percebido e habilidade percebida** — desafio alto demais gera ansiedade, baixo demais gera tédio — mais metas claras e feedback imediato e inequívoco. É a justificativa teórica tanto do matchmaking justo (seção 3.1) quanto da dificuldade adaptativa: ambos são tentativas de manter o jogador no canal.

### 4.3 Metas específicas, difíceis e com feedback

Locke & Latham (2002, *American Psychologist* — [PDF, Stanford](https://med.stanford.edu/content/dam/sm/s-spire/documents/PD.locke-and-latham-retrospective%5FPaper.pdf)): 35 anos de pesquisa convergem em — metas **específicas e difíceis** produzem performance superior a metas vagas ("faça o seu melhor") ou fáceis; os efeitos dependem de **feedback sobre o progresso**, comprometimento com a meta e a meta ser percebida como alcançável (metas impossíveis quebram a relação). Sub-metas de curto prazo são o mecanismo de metas de longo prazo. "Corra mais" é uma meta vaga; "mantenha cadência ≥150 por 30 segundos" é uma meta de Locke & Latham.

### 4.4 Aceleração perto do objetivo e o progresso dotado

- **Goal-gradient**: esforço aumenta conforme a recompensa se aproxima. No experimento de campo do café ([Kivetz, Urminsky & Zheng 2006, *Journal of Marketing Research*](https://business.columbia.edu/sites/default/files-efs/pubfiles/1200/goalgradient.pdf)): clientes com cartão de 12 espaços e 2 selos "bônus" pré-carregados completaram as 10 compras requeridas **mais rápido** que clientes com cartão simples de 10 espaços — mesmo esforço real, motivação diferente. Também documentam "post-reward resetting": após resgatar, o ritmo cai e reinicia.
- **Endowed progress** ([Nunes & Drèze 2006, *Journal of Consumer Research*](https://students.marshall.usc.edu/sites/default/files/jnunes/intellcont/Endowed%20Progress%20Effect-1.pdf)): no lava-rápido, cartões 2-de-10 (com 2 selos de brinde) completaram mais e mais rápido que cartões 0-de-8 — porque a tarefa é reframada como **já começada e incompleta** em vez de não-iniciada, não por avareza sobre os selos.

É o mesmo mecanismo que torna perigoso um passe de batalha com 10 páginas já "quase completas" — a diferença ética está em o que existe no fim da barra (ver seção 5).

### 4.5 Reforço intermitente: o motor do slot machine

Ferster & Skinner, *Schedules of Reinforcement* (1957 — [PDF da B. F. Skinner Foundation](https://www.bfskinner.org/wp-content/uploads/2015/05/Schedules%5Fof%5FReinforcement%5FPDF.pdf)): o catálogo experimental de como a cadência de recompensa molda comportamento. Esquemas de **razão variável** (recompensa após número imprevisível de respostas) produzem as taxas de resposta mais altas e mais resistentes à extinção — é o princípio do caça-níquel. Relevância aqui: loot boxes são razão variável monetizada (seção 5.2); e a mesma matemática aparece benignamente em qualquer jogo cuja diversão vem de variabilidade de resultado — a linha ética não é a variabilidade, é o que se paga (dinheiro, tempo, atenção) por cada puxada de alavanca.

### 4.6 Aversão à perda

Kahneman & Tversky (1979, *Econometrica* — [DOI 10.2307/1914185](https://doi.org/10.2307/1914185)): a função de valor é mais íngreme para perdas que para ganhos — "losses loom larger than gains". É a base de streaks-por-medo, de ofertas "só hoje", de ranks com decaimento e da monetização de restauração do Snapchat. O mesmo fenômeno, usado ao contrário, explica por que **não tirar** pontos do jogador (ou tirar simbolicamente) mantém a experimentação divertida — e por que a Nintendo dá pontos em derrota.

### 4.7 Comparação social — e sua versão saudável

Festinger (1954, *Human Relations* — [DOI](https://doi.org/10.1177/001872675400700202)): existe um drive de avaliar as próprias habilidades; na ausência de medida objetiva, avaliamo-nos por comparação com outros, preferencialmente **similares**. Corolários práticos: leaderboards só motivam quem se percebe próximo do topo (daí ranks por faixa, ligas regionais, divisões); comparação com curadoria idealizada dos outros é o mecanismo de dano apontado no post do Facebook (2.4); e **comparação com o próprio eu passado é a forma objetiva e não-tóxica** de satisfazer o mesmo drive — é o design do Strava, do ghost do Mario Kart e dos Best Efforts.

### 4.8 Exergames: evidência aplicada diretamente a este projeto

Um jogo controlado pelo corpo não compete só com outros jogos — compete com o sofá. A literatura de exergames é portanto evidência de primeira classe:

- **RCT de 12 semanas (n=189)** comparando video games de exercício (EVG) com exercício padrão ([PMC10653676](https://pmc.ncbi.nlm.nih.gov/articles/PMC10653676/)): o grupo EVG reportou **afeto mais positivo durante o exercício** e menor percepção de esforço; afeto positivo durante o exercício **predisse participação em atividade física 6 meses depois**; e só o grupo EVG mostrou melhora semana a semana no afeto *antes* do exercício — as pessoas passaram a **esperar com prazer** a sessão. É a cadeia completa: diversão → antecipação positiva → adesão.
- **RCT crossover (n=83)** VR vs exercício equivalente sem VR: maior aumento de afeto na condição VR ([Games for Health Journal 2024](https://doi.org/10.1089/g4h.2024.0026)).
- **Nuance honesta**: em reabilitação geriátrica (n=54), a adesão ao grupo exergame Kinect *caiu* abaixo do grupo com folhetos até o dia 10 ([PMC5363020](https://pmc.ncbi.nlm.nih.gov/articles/PMC5363020/)) — novidade não sustenta hábito sozinha, e exergame mal calibrado para a população frustra. Calibrar dificuldade e celebrar progresso não é opcional: é o mecanismo.

---

## 5. Análise ética — onde está a linha da manipulação

### 5.1 Taxonomias de referência

- **Zagal, Björk & Lewis (2013)**, *Dark Patterns in the Design of Games* ([paper FDG](http://www.fdg2013.org/program/papers/paper06_zagal_etal.pdf)): dark patterns de jogo em três categorias segundo o que é extraído do jogador — **tempo** (grinding: tarefas repetitivas cujo único propósito é estender a duração; *playing by appointment*: obrigar login em horários impostos pelo jogo), **dinheiro** (pay-to-skip, monetização de rivalidade) e **capital social** (pirâmides sociais: usar amizades como recurso de marketing, spam de convites). Pergunta-teste dos autores: o jogador consegue prever o compromisso de tempo que o jogo exige? Ele sentiria que "perdeu tempo"?
- **Gray et al. (2018)**, *The Dark (Patterns) Side of UX Design* (CHI — [DOI](https://dl.acm.org/doi/10.1145/3173574.3174108)): cinco estratégias — *nagging* (interrupções persistentes), *obstruction* (dificultar o que o usuário quer), *sneaking* (ocultar/adicionar sem consentimento), *interface interference* (hierarquia visual manipulada), *forced action* (exigir ação não relacionada para continuar).
- **FTC**, *Bringing Dark Patterns to Light* (staff report, set/2022 — relatório removido do ar no site da FTC; [cópia arquivada](https://web.archive.org/web/2022/https://www.ftc.gov/reports/bringing-dark-patterns-light)): enquadramento regulatório americano — dark patterns como práticas que enganam ou manipulam consumidores, incluindo em jogos e compras in-app de crianças.
- **CMA (Reino Unido)**, *Online Choice Architecture* (2022 — [página de publicação](https://www.gov.uk/government/publications/online-choice-architecture-how-digital-design-can-harm-competition-and-consumers), [evidence review de 261 páginas](https://assets.publishing.service.gov.uk/media/6258499fd3bf7f600e76d9de/OCA_Evidence_Review_Paper_14.4.22.pdf)): 21 práticas em três grupos — estrutura de escolha, informação de escolha, **pressão de escolha** (escassez e urgência, inclusive as artificiais).

### 5.2 Os mecanismos, um a um: uso legítimo vs versão manipulativa

| Mecanismo | Uso legítimo | Versão dark pattern | Veredito para este projeto |
|---|---|---|---|
| Streak/cadeia de dias | Ritual de retorno voluntário, barra baixa, com pausa protegida (Apple: 90 dias) | Hourglass de ansiedade + restauração **paga** (Snapchat) ou punição desproporcional | Adotar sem perda punitiva; nunca monetizar a perda |
| Metas diárias | Meta específica, alcançável, ajustada ao histórico, escolhida pelo jogador | Metas impossíveis que exigem retorno constante; *playing by appointment* | Adotar com autonomia (editar/recusar) |
| Ranks/ligas | Auto-hierarquia visível de progresso com degrau seguinte sempre alcançável | Rank com **decaimento** por inatividade; MMR que pune melhora real (o caso que a Riot esconde) | Adotar rank monotônico ou de melhor-marca; sem decaimento |
| Recompensa variável | Variabilidade de gameplay que o jogador não paga para repetir | Loot box paga: [Zendle & Cairns 2018](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0206767) — gasto em loot box correlaciona com severidade de jogo problemático (η²=0,054; [replicação 2019](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0213194)), link mais forte que outros itens pagos | Irrelevante aqui (zero monetização); mesmo assim, não usar roleta de recompensa cosmética |
| Escassez/urgência | Evento comemorativo real, raro, sem vantagem competitiva | Battle pass que **expira** recompensas (Fortnite) — pressão artificial sobre bem digital de custo marginal zero | Não implementar expiração de nada |
| Matchmaking/dificuldade | Justiça/fluxo: partida equilibrada, dificuldade calibrada declarada | **EOMM**: pareamento/dificuldade otimizado para retenção em vez de qualidade ([arXiv:1702.06820](https://arxiv.org/abs/1702.06820)) | DDA transparente e declarado, com opt-out |
| Feed/recomendação | Sequência que serve o interesse do usuário | Otimização de tempo de sessão como função objetivo (documentada no system card do Instagram) | Não existe feed aqui — não criar um |
| Notificações | Lembretes opt-in em horário escolhido pelo usuário | Nagging + ampulheta + reengajamento por culpa ("seu streak vai morrer!") | Site estático nem tem push — manter assim |
| Endowed progress/goal-gradient | Começar o jogador já "dentro" de uma jornada real com recompensa real | Barra pré-cheia rumo a compra/pay-to-skip | Usar só para progressão gratuita real |
| Comparação social | Competição entre presentes na sala; comparação consigo mesmo | Comparação pública permanente com curadoria idealizada; league tables que expõem os piores | Auto-comparação; social só presencial |

### 5.3 O teste prático: engajamento como meio ou como fim

Os documentos acima convergem num critério simples que este projeto pode adotar como regra de revisão:

1. **Quem se beneficia da métrica otimizada?** Se a função objetivo é tempo/retorno/gasto do usuário (system cards do Instagram, EOMM), o usuário é o meio. Se é a qualidade da partida/sessão (TrueSkill, Dota, Riot), o usuário é o fim.
2. **O mecanismo sobreviveria à transparência total?** A Valve publicou a distribuição de MMR e os critérios de pareamento; a Meta publica system cards porque foi obrigada. Regra prática: escrever o mecanismo no README — se envergonha, não implementar.
3. **A perda é real ou fabricada?** Perder uma partida é real; perder um streak de 400 dias por causa de um domingo de gripe é fabricada — a cadeia só existe para criar o medo de perdê-la (caso contrário não se venderia restauração).
4. **O tempo do jogador é respeitado?** Zagal: o jogador consegue prever o compromisso? Wordle respeita (1 puzzle/dia, ~5 min); infinite scroll não respeita por construção.
5. **Crianças/jovens conseguiriam entender o mecanismo?** Testemunhos de Mosseri e Zuckerberg ao Congresso ([Mosseri 2021](https://www.commerce.senate.gov/wp-content/uploads/media/doc/Mosseri%20Testimony.pdf), [Zuckerberg 2024](https://www.judiciary.senate.gov/imo/media/doc/2024-01-31_-_testimony_-_zuckerberg.pdf)) mostram que toda a indústria é hoje avaliada por esse padrão — vale adotá-lo desde já, voluntariamente.

### 5.4 Prova de que dá para fazer diferente — pelas próprias plataformas

O argumento "sem dark patterns não há engajamento" é refutado pelas próprias fontes primárias: Wordle viralizou globalmente limitando o consumo a 1 puzzle/dia ([GDC Vault](https://gdcvault.com/play/1027882/-Wordle-Doing-the-Opposite)); a Nintendo lucra com ranks que têm botão de pausa e pontos em derrota ([Ask the Developer](https://www.nintendo.com/us/whatsnew/ask-the-developer-vol-5-nintendo-switch-sports-part-4/)); a Apple mantém o streak de prêmios de quem pausa por 90 dias ([suporte oficial](https://support.apple.com/guide/watch/adjust-your-activity-ring-goals-apd29b30023c/watchos)); o Duolingo **removeu** a exigência de meta diária do streak quando viu que ela punia os mais ambiciosos ([blog](https://blog.duolingo.com/improving-the-streak/)); e o Facebook aceitou -50M horas/dia para priorizar interação significativa ([testemunho UK](https://committees.parliament.uk/writtenevidence/132928/html/)). A versão ética não é a versão menos engajante — é a versão que engaja pelo motivo certo (competência, progresso real, vínculo) e portanto de forma mais duradoura.

---

## 6. Tradução para um jogo web local/estático — princípios implementáveis

Mapeamento dos mecanismos para a realidade de um site estático: sem contas, sem servidor, sem push, com armazenamento local e APIs de compartilhamento do navegador. Referências de plataforma: [Web Share API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Share_API), [MediaRecorder](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder), [canvas.captureStream](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/captureStream), [IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API), [Compression Streams](https://developer.mozilla.org/en-US/docs/Web/API/Compression_Streams_API) (Baseline desde mai/2023), [Clipboard API](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API), cotas de armazenamento em [web.dev/storage-for-the-web](https://web.dev/articles/storage-for-the-web).

### 6.1 Auto-comparação sem servidor: o arquivo pessoal é o leaderboard

- **Persistir histórico de sessões em IndexedDB** (localStorage só para flags pequenas; cotas de dezenas de MB+ na prática — web.dev). Modelo Strava Best Efforts: melhores marcas da vida + melhores por semana/mês, por métrica e por modalidade.
- **Métricas certas para um jogo de corpo**: além de score — duração ativa em minutos (a métrica do Oculus Move), cadência máxima sustentada, maior sequência de hurdles sem erro, maior rally, média de erro de timing no tênis. Métricas de *habilidade* e de *saúde* separadas das de score.
- **"Compare com você mesmo" visual**: mini-gráfico das últimas N sessões na tela de fim de jogo; seta vs média pessoal; "3ª melhor marca da sua história". Nunca exibir percentis inventados de "outros jogadores" — percentil fabricado apresentado como real é engano (seção 5.3, regra da transparência). Se um dia se quiser contexto populacional, rotular explicitamente como estimativa de modelo.
- **Novos recordes são eventos**: detectar no momento e celebrar na hora (ver 6.7) — o PR é a unidade de recompensa mais barata e mais honesta que existe.

### 6.2 Metas e missões locais

- **Missões determinísticas por data**: seed = dia ISO → seleção pseudo-aleatória *idêntica para qualquer pessoa no mesmo dia* (o efeito "um puzzle para todo mundo" do Wordle) — mesmo sem servidor, dois amigos que abram o jogo no mesmo dia recebem a mesma missão, e isso é conversável ("você conseguiu a missão de hoje?").
- **Receita Locke & Latham**: específica ("mantenha cadência ≥150 spm por 30 s"), difícil mas alcançável (derivada do histórico local: alvo ≈ 85-95° percentil do que o jogador já demonstrou), com feedback de progresso em tempo real (barra visível durante a corrida — goal-gradient, seção 4.4).
- **Autonomia**: missão pode ser trocada/recusada sem custo; a barra do hábito ("jogou 5 minutos") separada da barra da ambição — a lição do desacoplamento do Duolingo.
- **Sem expiry punitiva**: missão não cumprida simplesmente passa; nenhum recurso é perdido.

### 6.3 Ranks locais honestos

- **Liga pessoal por melhor marca**: tiers (Bronze→∞) ancorados em limiares objetivos de métrica, monotônicos ou baseados em melhor desempenho histórico — nunca em valor que decai com o tempo. O rank é uma *vitrine de conquista*, não uma medida de habilidade corrente (a separação que a Riot faz entre LP e MMR, 3.1).
- **Convite tardio**: mostrar ranks só depois de algumas sessões — a Nintendo esconde a Pro League até o jogador se acostumar; mesmo motivo: rank no dia 1 é comparação sem base e assusta novatos.
- **Botão de pausa**: opção de esconder ranks/missões e jogar "no modo zen" — o Pause Pro é barato de implementar e é um statement de design.

### 6.4 Matchmaking contra si mesmo: dificuldade adaptativa ética

- O oponente é a IA — então "matchmaking" = calibrar a IA e os parâmetros de dificuldade para manter o jogador no canal de fluxo (desafio ≈ habilidade). Implementação clássica: estimador de performance em janela móvel (taxa de contato no tênis, % de hurdles limpos) → ajuste suave de velocidade/placement/erro da IA com alvo de taxa de sucesso ~70-85% (zona de flow arcade — valor de design, afinável).
- **Transparência**: declarar no jogo que a dificuldade se adapta ("a IA se ajusta ao seu nível") + opt-out para dificuldade fixa. O EOMM é manipulativo não por adaptar, mas por otimizar retenção em segredo; DDA declarado que maximiza *diversão por sessão* é o uso legítimo da mesma matemática ([Hunicke & Chapman 2004](https://aaai.org/papers/ws04-04-019-ai-for-dynamic-difficulty-adjustment-in-games/): "jogos são chatos quando fáceis demais e frustrantes quando difíceis demais").
- **Nunca manipular resultado para "manter esperança"** (rubber-banding invisível de placar): o jogador deve poder confiar que venceu porque jogou bem — a confiança no feedback é o que sustenta competência percebida (SDT).

### 6.5 Compartilhamento sem backend

- **Texto estilo Wordle**: resultado da sessão como grade/linha compacta copiável (ex.: `🏃 Hurdle Rush 27/30 — 🟩🟩🟥🟩🟩… novo recorde!` + URL) via Clipboard API — texto puro atravessa qualquer mensageiro, zero infraestrutura.
- **Share card como imagem**: renderizar um card (score, rank, data, arte do jogo) num canvas offscreen → `toBlob` → `navigator.share({files})` (Web Share nível 2) com fallback para download de PNG. A imagem carrega identidade visual (6.7) para fora do jogo.
- **Desafio por URL**: para replays pequenos, estado comprimido com CompressionStream (gzip nativo) + base64url no fragmento da URL — abrir o link carrega o desafio/ghost. Limitação honesta: fragmentos longos podem ser truncados por alguns mensageiros; para replays grandes, exportar arquivo `.json.gz` e compartilhar como anexo. (Não há spec de limite de URL; o gargalo prático é o transporte, não o navegador.)
- **Sem preview dinâmico de crawler**: num site estático não há como gerar og:image por usuário no servidor — o compartilhamento rico acontece no arquivo/imagem anexada, não no preview do link. Aceitar a limitação em vez de fingir.

### 6.6 Replay determinístico e fantasma — o superpoder do passo fixo

- Este projeto já roda **passo fixo de 1/60 s** (`src/games/core/GameLoop.ts`) e eventos de input com timestamps (`SportActionEvent.timestampMs`). Um replay é: seed inicial + linha do tempo de inputs. Pré-requisito real identificado no código: `TrackGame.ts` usa `Math.random()` para spawn de hurdles — replay exige RNG semeado (ou gravação dos spawns). Esse é o tipo de refatoração pequena com retorno enorme.
- **Fantasma do melhor run** (o mecanismo de 1997 do Mario Kart): gravar a sequência de inputs/estados-chave do recorde e re-simular num runner translúcido. Na corrida é trivial geometricamente (posição por raia ao longo do tempo); no tênis, ghost de rally é mais complexo — começar pela corrida.
- **Highlights em vídeo**: `canvas.captureStream()` + `MediaRecorder` → `.webm` local (a mesma escolha da Riot para highlights) — nos 10-20 s em torno de um recorde, com consentimento explícito. Nenhum frame sai do dispositivo a menos que o usuário compartilhe.
- **Replay com formato próprio versionado** desde o dia 1 — a expiração-a-cada-patch do League é o que acontece quando o formato é acoplado à build.

### 6.7 Identidade visual e celebração

- **Conquista precisa ser sentida**: toast + som + pausa dramática de ~1 s no desbloqueio (padrão de plataforma do Quest); animação especial em milestones (a fênix do Duolingo). Confete/partículas em PR.
- **Identidade persistente**: o jogador local escolhe nome/cor/avatar simples — o Mii mínimo. A lição do Iwata Asks não é "editor complexo", é *representação pessoal com fricção zero*: o PiP da webcam já mostra o próprio corpo — a identidade mais forte possível já está na tela; o avatar é complemento.
- **Vitrine de conquistas**: tela de achievements com estados bloqueado/em-progresso/desbloqueado e ícones cinza/colorido (o vocabulário Quest simple/count/bitfield cobre tudo que este jogo precisa: "simple" = primeiro smash; "count" = 100 hurdles na vida; "bitfield" = jogar os 2 esportes em 3 dias diferentes).
- **Achievements secretos** com parcimônia: 1-2 surpresas de exploração são encantamento; 30 é checklist artificial.

### 6.8 O canal social que não precisa de rede: presença local

- Wii Sports nasceu para a sala de estar: **pass-and-play** (turnos alternados no mesmo dispositivo, placar lado a lado) é multiplayer sem servidor, sem conta e sem latência — e é o formato que transforma o PiP da webcam em show para quem está no sofá (espectador presencial).
- O insight do Facebook sobre uso ativo vs passivo (2.4) inverte-se aqui a favor do jogo: jogar exergame **é** atividade, não consumo — e jogar *com alguém presente* é o "uso ativo com amigos próximos" que a própria pesquisa da Meta associou a bem-estar.
- Miis-na-plateia local: recordes de familiares/amigos no mesmo dispositivo aparecem como fantasmas/marcas nomeadas — comparação com similares (Festinger) na única escala em que ela é saudável por construção: a sala.

---

## 7. Aplicação ao Wii Web Sports Arena — recomendações priorizadas

Estado atual verificado no código: no último merge de `main` (`ecd481e`) **não existe nenhuma persistência** — toda sessão morre ao fechar a aba, o equivalente a um Strava que esquece cada corrida. **Trabalho paralelo em andamento** (working tree da branch `feat/engagement-loop`, orientado por `docs/pesquisa-engajamento-jogos.md`) já implementa os primeiros degraus recomendados aqui: `src/games/engagement/progressStore.ts` (persistência local com degradê para memória), `progression.ts` (ranks NOVATO→ELITE por XP monotônico — sem decaimento, alinhado com §5) e `src/games/track/trackDirector.ts` (dificuldade adaptativa na corrida). Fatos persistentes relevantes: o loop é passo fixo 1/60 (`GameLoop.ts`), eventos carregam `timestampMs`, e os hurdles ainda usam `Math.random()` não semeado (`TrackGame.ts:180`) — os módulos novos do tênis já nasceram puros e sem `Math.random` embutido (`opponentAi.ts`, `ballistics.ts`), padrão a seguir.

As recomendações abaixo assumem esse trabalho como ponto de partida: os itens 1-4 **completam e endurecem** o que está sendo construído; os demais cobrem o que ainda não existe em branch nenhuma.

| # | Prioridade | Recomendação | Mecanismo-raiz | Esforço |
|---|---|---|---|---|
| 1 | **P0** | **Estender o arquivo pessoal além de score/XP**: histórico de sessões datadas + melhores marcas por métrica por esporte (minutos ativos, cadência máxima sustentada, maior sequência limpa de hurdles, rally mais longo, erro médio de timing no tênis) — o `ProgressStore` atual guarda `bestScore/plays/xp`; o modelo Strava Best Efforts é multi-métrica e com recorte temporal (vida/ano/semana). Tudo mais depende disso. | Strava Best Efforts; Festinger auto-comparação | M |
| 2 | **P0** | **Celebração de recorde no momento, não só no fim**: detectar PR em tempo real e interromper com toast+som+partículas; tela de fim de jogo com "vs sua média" e posição da sessão na sua história ("2ª melhor marca"). O `isRecord`/`rankUp` de `recordSportResult` já expõe os gatilhos — falta a celebração sentida. | Toast+som Quest; milestone/fênix Duolingo; SDT-competência | P |
| 3 | **P0** | **Missões diárias/semanais determinísticas locais** (seed pela data ISO — mesma missão para qualquer pessoa no mesmo dia, o efeito Wordle sem servidor), específicas e calibradas pelo histórico (~85-95° percentil do já demonstrado), com barra de progresso in-game, trocáveis sem custo, sem punição por falha. | Locke & Latham; Wordle 1/dia; goal-gradient | M |
| 4 | **P0** | **Tornar a dificuldade adaptativa declarada e com opt-out**: o `TrackDirector` já adapta — falta a camada ética: texto visível ("a dificuldade se ajusta ao seu nível") e configuração para dificuldade fixa; mesmo tratamento no `opponentAi` do tênis, com alvo de taxa de sucesso na zona de flow. É a diferença entre DDA honesto e EOMM (§3.2, §5.3). | Flow; Hunicke DDA; anti-EOMM por transparência | P |
| 5 | **P1** | **RNG semeado + gravação de inputs → fantasma do melhor run na corrida** e replay de partida com formato versionado próprio. Substituir `Math.random()` por PRNG com seed registrada; gravar eventos timestamped; re-simular translúcido. Começar pela corrida (geometria trivial); tênis depois. | Mario Kart ghost (1997); League replays (e sua lição de expiração por patch) | G |
| 6 | **P1** | **Compartilhamento estilo Wordle**: linha de texto copiável com grade da sessão (Clipboard API) + share card renderizado em canvas compartilhável via Web Share API com arquivos; sem servidor, sem conta, sem og:image dinâmico (limitação aceita, §6.5). | Wordle emoji grid; Web Share API | P |
| 7 | **P1** | **Modo zen / pausa de ranks** (esconder ranks e missões) e convite tardio: mostrar a liga pessoal só após algumas sessões. Os ranks por XP monotônico já estão corretos — falta o direito de desligar, o "Pause Pro". | Pro League + Pause Pro (Nintendo); separação MMR/LP da Riot | P |
| 8 | **P1** | **Ritual de retorno sem medo**: ao reabrir, mostrar progresso da semana e continuidade gentil ("3 sessões esta semana — sua melhor semana!"). Se um dia houver cadeia de dias, implementar desde já com pausa protegida (modelo Apple: até 90 dias sem quebrar) e sem ampulheta de ansiedade — nunca o modelo Snap de perda vendida. | Streak Duolingo desacoplado; Apple pause rings; contraexemplo Snap | P |
| 9 | **P2** | **Achievements com vocabulário Quest** (simple/count/bitfield), vitrine cinza/colorida, 1-2 secretos; identidade visual própria com animação de milestone e nome/cor escolhidos pelo jogador. | Meta Quest achievements; fênix Duolingo; Mii (fricção zero) | M |
| 10 | **P2** | **Pass-and-play local com placar lado a lado** e nomes de familiares nos recordes/ghosts — multiplayer de sofá sem rede, com espectador presencial. | Wii Sports sala de estar; Festinger-comparação-com-similares | G |
| 11 | **P2** | **Highlights em .webm opt-in** via `canvas.captureStream` + `MediaRecorder` nos segundos em torno de recordes — nunca gravação contínua, consentimento explícito por sessão. | Riot highlights | M |
| 12 | **P2** | **Minutos ativos como métrica de primeira classe** na tela de fim de jogo e no histórico — reposiciona o jogo como exercício prazeroso, a cadeia afeto→adesão dos RCTs de exergame. | Oculus Move; RCT exergames ([PMC10653676](https://pmc.ncbi.nlm.nih.gov/articles/PMC10653676/)) | P |

**Compromissos éticos explícitos do projeto** (a escrever no README quando a primeira feature de engajamento for implementada): sem expiração de conteúdo; sem decaimento de rank; sem notificações externas; sem métricas públicas fabricadas; sem variável-ratio monetizado (não há monetização); dificuldade adaptativa sempre declarada; tempo de sessão nunca é função objetivo de nada — o sucesso é o jogador voltar *porque quer*, idealmente com alguém ao lado.

---

## 8. Limitações desta pesquisa

1. Os dados de retenção do Duolingo são os números que a empresa escolheu publicar de seus A/B tests — direção e ordem de grandeza são críveis, mas não há acesso aos instrumentos. Idem para testemunhos da Meta a legisladores: úteis como admissão contra interesse, não como medida neutra.
2. RCTs de exergames têm amostras pequenas/moderadas e populações específicas; o efeito afeto→adesão é consistente entre estudos mas o tamanho varia.
3. EOMM é simulação sobre dados reais, não deploy confirmado — citado como articulação de uma lógica, não como prova de uso em produção.
4. Os mecanismos foram traduzidos para um contexto (jogo de movimento, estático, sem contas) que nenhuma das fontes cobre diretamente; as prioridades da seção 7 refletem julgamento de engenharia sobre esse gap, não evidência direta. O próprio projeto deve medir (sessões por semana por usuário local, completude de missões) quando as features existirem — benchmark antes de otimizar, como manda a filosofia do repositório.
