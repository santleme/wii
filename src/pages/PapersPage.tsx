import { Link } from 'react-router-dom';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import CrystalAsciiField from '../components/CrystalAsciiField';
import { paperLines, papers, type Paper } from '../data/papers';
import { useLang } from '../i18n';
import { orbitRadii } from './papersOrbit';

const LINE_MS = 4800;

/** Os artigos (propostas de pesquisa) giram numa elipse em volta do título; clicar abre o resumo e a figura. */
export default function PapersPage() {
  const { lang, tr } = useLang();
  // Texto do artigo no idioma atual (PT nos campos base, EN em p.en).
  const copyOf = (p: Paper) => ({ short: tr(p.short, p.en.short), title: tr(p.title, p.en.title), blurb: tr(p.blurb, p.en.blurb) });
  const ringRef = useRef<HTMLDivElement>(null);
  const rotateRef = useRef<((index: number, done: () => void) => void) | null>(null); // gira o anel ate um cartao ficar na frente
  const busy = useRef(false); // enquanto o anel gira, novos cliques esperam
  const openRef = useRef(false); // com um resumo aberto o carrossel desacelera ate parar, sem corte seco
  const focusRef = useRef(false); // idem enquanto o foco do teclado esta num cartao (o alvo nao pode fugir)
  const [open, setOpen] = useState<Paper | null>(null);
  const [shown, setShown] = useState<Paper | null>(null); // mantem o painel montado enquanto ele recolhe
  useEffect(() => { if (open) setShown(open); }, [open]);
  const [line, setLine] = useState(0);
  const reduce = useRef(window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  useEffect(() => { openRef.current = open !== null; }, [open]);

  // Carrossel elíptico: o que passa à frente fica maior e mais nítido, o de trás menor e apagado.
  // Por quadro so se escrevem transform/opacity (nenhuma leitura de layout): medidas ficam em cache e
  // so mudam num ResizeObserver; o ponteiro nunca pausa a rotacao; so abrir um resumo ou focar um cartao a desacelera.
  useEffect(() => {
    const ring = ringRef.current;
    if (!ring) return;
    const cards = Array.from(ring.children) as HTMLElement[];
    const front = cards.map(() => false);
    const compact = window.matchMedia('(max-width: 480px)');
    let rx = 0;
    let ry = 0;
    const measure = () => {
      let maxWidth = 0;
      let maxHeight = 0;
      for (const card of cards) {
        maxWidth = Math.max(maxWidth, card.offsetWidth);
        maxHeight = Math.max(maxHeight, card.offsetHeight);
      }
      ({ x: rx, y: ry } = orbitRadii(ring.clientWidth, ring.clientHeight, maxWidth, maxHeight));
    };
    let angle = -Math.PI / 2;
    let speed = 0.09; // rad/s
    let last = performance.now();
    let raf = 0;
    let tween: { from: number; to: number; t0: number; dur: number; done: () => void } | null = null;
    const TAU = Math.PI * 2;
    // Gira pelo menor caminho ate o cartao i chegar na frente (parte de baixo da elipse), depois chama done.
    const rotateTo = (i: number, done: () => void) => {
      if (compact.matches) { done(); return; }
      if (reduce.current) {
        angle = Math.PI / 2 - (i / cards.length) * TAU;
        place();
        done();
        return;
      }
      const base = Math.PI / 2 - (i / cards.length) * TAU;
      // Menor caminho: vai para o lado (horario ou anti-horario) em que o cartao chega mais perto da frente.
      const delta = ((((base - angle) % TAU) + TAU + Math.PI) % TAU) - Math.PI;
      if (Math.abs(delta) < 0.02) { done(); return; }
      tween = { from: angle, to: angle + delta, t0: performance.now(), dur: Math.min(2400, 900 + Math.abs(delta) * 350), done };
    };
    rotateRef.current = rotateTo;
    const place = () => {
      cards.forEach((el, i) => {
        if (compact.matches) {
          // Keep the title clear: two cards above, two below, and one at the bottom.
          const x = i === 4 ? 0 : (i % 2 === 0 ? -1 : 1) * rx;
          const y = i < 2 ? -ry : i < 4 ? ry * 0.35 : ry;
          el.style.transform = `translate3d(calc(-50% + ${x.toFixed(2)}px), calc(-50% + ${y.toFixed(2)}px), 0)`;
          el.style.opacity = '1';
          el.style.zIndex = '5';
          front[i] = false;
          return;
        }
        const a = angle + (i / cards.length) * Math.PI * 2;
        const depth = (Math.sin(a) + 1) / 2; // 1 = frente (parte de baixo da elipse)
        const scale = 0.84 + 0.16 * depth;
        el.style.transform = `translate3d(calc(-50% + ${(Math.cos(a) * rx).toFixed(2)}px), calc(-50% + ${(Math.sin(a) * ry).toFixed(2)}px), 0) scale(${scale.toFixed(4)})`;
        el.style.opacity = (0.88 + 0.12 * depth).toFixed(3);
        const f = depth > 0.62; // atras do titulo; na frente dele so quando passa por baixo
        if (f !== front[i]) { front[i] = f; el.style.zIndex = f ? '30' : '5'; }
      });
    };
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05); // aba em segundo plano nao da salto
      last = now;
      if (tween) {
        const t = tween;
        const p = Math.min(1, (now - t.t0) / t.dur);
        const e = p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2; // ease in-out cubico
        angle = t.from + (t.to - t.from) * e;
        if (p >= 1) {
          tween = null;
          speed = 0;
          place();
          t.done();
          raf = requestAnimationFrame(tick);
          return;
        }
      } else {
        const target = openRef.current || focusRef.current ? 0 : 0.09;
        speed += (target - speed) * Math.min(1, dt * 4);
        angle += speed * dt;
      }
      place();
      raf = requestAnimationFrame(tick);
    };
    measure();
    place();
    const ro = new ResizeObserver(() => { measure(); place(); });
    const onCompactChange = () => { measure(); place(); };
    compact.addEventListener('change', onCompactChange);
    ro.observe(ring);
    for (const card of cards) ro.observe(card);
    if (!reduce.current) raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      compact.removeEventListener('change', onCompactChange);
      rotateRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (reduce.current || open) return;
    const id = window.setInterval(() => setLine((l) => (l + 1) % paperLines.length), LINE_MS);
    return () => window.clearInterval(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (ringRef.current?.contains(document.activeElement)) focusRef.current = true;
      if (e.key === 'Escape') setOpen(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Clicar em outro artigo: fecha o atual, gira o anel ate ele e so depois o abre.
  const pick = (p: Paper) => {
    // Mesmo com a pagina rolada para baixo, leva o foco ao centro, onde ficam os papers.
    ringRef.current?.scrollIntoView({ behavior: reduce.current ? 'auto' : 'smooth', block: 'center' });
    if (open?.n === p.n) { setOpen(null); return; }
    if (busy.current) return;
    busy.current = true;
    setOpen(null);
    const finish = () => { busy.current = false; setOpen(p); };
    if (rotateRef.current) rotateRef.current(papers.indexOf(p), finish);
    else finish();
  };

  return (
    <main className={`papers${open ? ' has-open' : ''}`} id="page-content">
      <CrystalAsciiField />
      {/* biome-ignore lint/a11y/useSemanticElements: The orbit cards are an interactive carousel, not form fields. */}
      <div
        className="papers-orbit product-emerge"
        style={{ '--emerge': 1500 } as CSSProperties}
        ref={ringRef}
        onFocus={(e) => { focusRef.current = e.target instanceof HTMLElement && e.target.matches(':focus-visible'); }}
        onPointerDown={() => { focusRef.current = false; }}
        onBlur={() => { focusRef.current = false; }}
        role="group"
        aria-label={tr('Artigos', 'Papers')}
      >
        {papers.map((p) => {
          const c = copyOf(p);
          return (
            <div className="papers-orbit-item" key={p.n}>
              <button
                type="button"
                className={`papers-card${open?.n === p.n ? ' is-open' : ''}`}
                aria-label={tr(`Artigo ${p.n}: ${c.short}`, `Paper ${p.n}: ${c.short}`)}
                aria-expanded={open?.n === p.n}
                onClick={() => pick(p)}
              >
                <span className="papers-card-n">{p.n}</span>
                <span className="papers-card-name">{c.short}</span>
              </button>
            </div>
          );
        })}
      </div>

      <div className="papers-center">
        <h1 className="papers-title product-emerge" style={{ '--emerge': 300 } as CSSProperties}>papers</h1>
        <div className={`papers-swap${open ? ' is-open' : ''}`}>
          <div className="papers-swap-inner">
            {shown && (
              <article className="papers-detail" aria-live="polite" aria-hidden={!open}>
                <p className="papers-detail-kicker">{tr(`proposta ${shown.n} de ${papers.length} · ainda sem resultados`, `proposal ${shown.n} of ${papers.length} · no results yet`)}</p>
                <h2 className="papers-detail-title">{copyOf(shown).title}</h2>
                <p className="papers-detail-blurb">{copyOf(shown).blurb}</p>
                <div className="papers-detail-actions">
                  <Link className="papers-open" to={`/papers/${shown.n}`}>{tr('abrir artigo', 'open article')}</Link>
                  <button type="button" className="papers-close" onClick={() => setOpen(null)}>{tr('fechar', 'close')}</button>
                </div>
              </article>
            )}
          </div>
        </div>
        <div className={`papers-swap${open ? '' : ' is-open'}`}>
          <div className="papers-swap-inner">
            <div>
              <p className="papers-line" key={`${line}-${lang}`} aria-live="off">{tr(paperLines[line].pt, paperLines[line].en)}</p>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
