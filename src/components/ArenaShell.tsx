import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useLang } from '../i18n';

const ArenaApp = lazy(() => import('../App'));

/** Moldura de `/app`: a arena esportiva e a transição de saída. */
export default function ArenaShell() {
  const { tr } = useLang();
  const navigate = useNavigate();
  const [leaving, setLeaving] = useState(false);
  const leaveTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);

  useEffect(() => {
    const siteTitle = document.title;
    document.title = 'Wii Web Sports — Arena';
    return () => { document.title = siteTitle; };
  }, []);

  // Saida = entrada ao contrario: a tela estoura em branco, e o site volta de longe, encolhendo ate o tamanho normal.
  const leave = (event: React.MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (leaving) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      navigate('/product');
      return;
    }
    setLeaving(true);
    leaveTimer.current = window.setTimeout(() => {
      document.body.classList.add('is-arriving');
      navigate('/product');
      // Invariante: este timer PRECISA sobreviver à shell — ele encerra a animação de chegada
      // (body.is-arriving, 1,5 s em site.css) já na página de destino, com a ArenaShell desmontada
      // pela navegação. Guardá-lo no leaveTimer e limpá-lo no cleanup travaria o body em overflow:hidden.
      window.setTimeout(() => document.body.classList.remove('is-arriving'), 1500);
    }, 1100);
  };

  const exitLink = (
    <Link className="arena-exit" style={{ zIndex: 30 }} to="/product" onClick={leave}>{tr('sair ↗', 'exit ↗')}</Link>
  );

  return (
    <main className={`arena-page${leaving ? ' is-leaving' : ''}`} id="page-content">
      <div className="arena-flash" aria-hidden="true" />
      {leaving && <div className="arena-leave" aria-hidden="true" />}
      <div className="arena">
        <Suspense fallback={null}><ArenaApp exit={exitLink} /></Suspense>
      </div>
    </main>
  );
}
