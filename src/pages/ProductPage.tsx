import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useSiteHand } from '../app/SiteHandContext';
import LocalErrorBoundary from '../components/LocalErrorBoundary';
import type { ProductHandStageHandle } from '../components/ProductHandStage';
import { useLang } from '../i18n';
import { runWarp } from '../lib/warp';

const loadProductHandStage = () => import('../components/ProductHandStage');

export default function ProductPage() {
  const { tr } = useLang();
  const navigate = useNavigate();
  const { stopCamera } = useSiteHand();
  const handStage = useRef<ProductHandStageHandle>(null);
  const stopWarp = useRef<() => void>(() => undefined);
  const [stageLoadAttempt, setStageLoadAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: stageLoadAttempt intentionally resets the failed lazy boundary.
  const ProductHandStage = useMemo(() => lazy(loadProductHandStage), [stageLoadAttempt]);
  useEffect(() => () => {
    stopWarp.current();
    document.body.classList.remove('is-falling');
  }, []);

  const enterArena = (event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (document.body.classList.contains('is-falling')) return;
    // The arena claims the camera and its own MediaPipe worker.
    stopCamera();
    handStage.current?.shutdown();
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      navigate('/app');
      return;
    }
    document.body.classList.add('is-falling');
    stopWarp.current = runWarp(() => {
      navigate('/app');
      // A arena ja nasce coberta pelo flash branco; so entao soltamos o tunel.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        stopWarp.current();
        document.body.classList.remove('is-falling');
      }));
    });
  };

  return (
    <main className="product-page" id="page-content">
      <section className="product-content">
        <Link className="product-status product-emerge group" style={{ '--emerge': 300 } as CSSProperties} to="/app" onClick={enterArena} aria-label={tr('Em construção. Abrir a arena Wii.', 'Under construction. Open the Wii arena.')}>
          <span className="status-dot" />
          {tr('em construção', 'under construction')}
          <span className="status-arrow" aria-hidden="true">↗</span>
        </Link>
        <figure className="construction-art">
          <LocalErrorBoundary
            key={stageLoadAttempt}
            label="Failed to load the product hand stage"
            fallback={
              <div className="hand-stage-fallback" role="alert">
                <p>{tr('Não foi possível carregar a mão em 3D.', 'The 3D hand could not be loaded.')}</p>
                <button type="button" className="article-retry" onClick={() => setStageLoadAttempt((attempt) => attempt + 1)}>
                  {tr('Tentar novamente', 'Try again')}
                </button>
              </div>
            }
          >
            <Suspense fallback={<div className="construction-ascii-canvas" aria-hidden="true" />}>
              <ProductHandStage ref={handStage} />
            </Suspense>
          </LocalErrorBoundary>
        </figure>
        <h1 className="product-headline product-emerge" style={{ '--emerge': 900 } as CSSProperties}>
          {tr('Do primeiro passo', 'From the first step')}
          <br />
          <em>{tr('ao próximo recorde.', 'to the next record.')}</em>
        </h1>
        <p className="product-description product-emerge" style={{ '--emerge': 1500 } as CSSProperties}>
          {tr(
            'Estamos construindo uma arena arcade no navegador, controlada pelo corpo. Corrida de obstáculos e tênis começam no seu movimento; o que a arena pode se tornar ainda está sendo construído.',
            'We are building an arcade arena in the browser, controlled by your body. Hurdle running and tennis start with your movement; what the arena can become is still being built.',
          )}
        </p>

        <Link className="vision-cta product-emerge" style={{ '--emerge': 2100 } as CSSProperties} to="/vision">
          {tr('Leia a visão', 'Read the vision')} <span aria-hidden="true">↗</span>
        </Link>
      </section>
    </main>
  );
}
