import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useState, type ErrorInfo, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import DrawTip from '../components/DrawTip';
import Intro from '../components/Intro';
import LocalErrorBoundary from '../components/LocalErrorBoundary';
import ScrollbarControl from '../components/ScrollbarControl';
import SiteHeader from '../components/SiteHeader';
import HomePage from '../pages/HomePage';
import PapersPage from '../pages/PapersPage';
import ProductPage from '../pages/ProductPage';
import ArenaShell from '../components/ArenaShell';
import VisionPage from '../pages/VisionPage';
import { SiteHandProvider, useSiteHand } from './SiteHandContext';
import { useLang } from '../i18n';

// Loaded only once the camera is asked for, so Three.js stays out of the initial bundle.
const SiteAsciiHand = lazy(() => import('../components/SiteAsciiHand'));
const SiteMiiPlaza = lazy(() => import('../components/SiteMiiPlaza'));

export default function App() {
  const location = useLocation();
  const [productRefresh, setProductRefresh] = useState(0);
  const [articleLoadAttempt, setArticleLoadAttempt] = useState(0);
  // Recreate lazy() on retry so a rejected import can be requested again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: articleLoadAttempt intentionally resets the failed lazy boundary.
  const ArticlePage = useMemo(() => lazy(() => import('../pages/ArticlePage')), [articleLoadAttempt]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
    document.body.classList.toggle('home-scroll', location.pathname === '/');
  }, [location.pathname]);

  const inArena = /^\/app\/?$/.test(location.pathname); // a arena e '/app'
  // A abertura toca a cada carregamento da pagina (nao a cada navegacao interna); a arena fica de fora.
  const [introOpen, setIntroOpen] = useState(() => !/^\/app\/?$/.test(location.pathname));

  return (
    <SiteHandProvider inArena={inArena}>
      {introOpen && <Intro onDone={() => setIntroOpen(false)} />}
      {!inArena && <DrawTip />}
      {!inArena && <SiteHeader
        onRepeatProduct={() => {
          setProductRefresh((revision) => revision + 1);
          window.scrollTo({ top: 0, behavior: 'instant' });
        }}
      />}
      <motion.div
        className="route-transition"
        key={location.pathname}
        initial={false}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, ease: 'easeOut' }}
      >
        <Routes location={location}>
          <Route path="/" element={<HomePage />} />
          <Route path="/vision" element={<VisionPage />} />
          <Route path="/papers" element={<PapersPage />} />
          <Route path="/papers/:n" element={
            <ArticleLoadBoundary
              key={`${location.pathname}:${articleLoadAttempt}`}
              onRetry={() => setArticleLoadAttempt((attempt) => attempt + 1)}
            >
              <Suspense fallback={<ArticleLoading />}><ArticlePage /></Suspense>
            </ArticleLoadBoundary>
          } />
          <Route path="/product" element={<ProductPage key={productRefresh} />} />
          <Route path="/app" element={<ArenaShell />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </motion.div>
      {!inArena && <ScrollbarControl />}
      {!inArena && !introOpen && (
        <Suspense fallback={null}>
          <SiteMiiPlaza />
        </Suspense>
      )}
      {!inArena && <SiteHandControls />}
    </SiteHandProvider>
  );
}

/** The 3D hand pointer and camera switch for every site page: hover and pinch-click, hold a fist to go back. */
function SiteHandControls() {
  const { tr } = useLang();
  const { camera, stopCamera } = useSiteHand();
  const navigate = useNavigate();
  const onProduct = /^\/product\/?$/.test(useLocation().pathname);
  const back = useCallback(() => {
    // react-router numbers the entries it created; at 0, going back would leave the site.
    if (window.history.state?.idx > 0) navigate(-1);
  }, [navigate]);
  if (camera === 'off') return null;
  return (
    <>
      <LocalErrorBoundary label="Failed to load the site hand" fallback={null}>
        <Suspense fallback={null}>
          <SiteAsciiHand onProduct={onProduct} onBack={back} />
        </Suspense>
      </LocalErrorBoundary>
      {/* /product has its own camera button under the stage. */}
      {!onProduct && (
        <button type="button" className="product-status site-camera-off" onClick={stopCamera}>
          <span className={camera === 'on' ? 'status-dot is-live' : 'status-dot'} />
          {tr('Desligar câmera', 'Turn camera off')}
        </button>
      )}
    </>
  );
}

function ArticleLoading() {
  const { tr } = useLang();
  return (
    <main className="article" id="page-content" aria-live="polite">
      <p>{tr('Carregando artigo…', 'Loading article…')}</p>
    </main>
  );
}

function ArticleFailed({ onRetry }: { onRetry: () => void }) {
  const { tr } = useLang();
  return (
    <main className="article" id="page-content">
      <Link className="article-back" to="/papers">← papers</Link>
      <p role="alert">{tr('Não foi possível carregar este artigo.', 'This article could not be loaded.')}</p>
      <button className="article-retry" type="button" onClick={onRetry}>{tr('Tentar novamente', 'Try again')}</button>
    </main>
  );
}

class ArticleLoadBoundary extends Component<{ children: ReactNode; onRetry: () => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Failed to load article', error, info);
  }

  render() {
    if (this.state.failed) {
      return <ArticleFailed onRetry={this.props.onRetry} />;
    }
    return this.props.children;
  }
}
