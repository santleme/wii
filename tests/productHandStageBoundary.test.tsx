// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangProvider } from '../src/i18n';
import ProductPage from '../src/pages/ProductPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => ({ stageRenders: 0 }));

vi.mock('../src/app/SiteHandContext', () => ({
  useSiteHand: () => ({ stopCamera: vi.fn() }),
}));

vi.mock('../src/components/ProductHandStage', () => ({
  default: () => {
    harness.stageRenders += 1;
    throw new Error('stage chunk failed');
  },
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  harness.stageRenders = 0;
  localStorage.setItem('wii-lang', 'pt');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('ProductHandStage boundary', () => {
  it('keeps the product page alive and retries only the failed stage', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <LangProvider>
            <ProductPage />
          </LangProvider>
        </MemoryRouter>,
      );
    });

    expect(harness.stageRenders).toBeGreaterThan(0);
    expect(container.textContent).toContain('Não foi possível carregar a mão em 3D.');
    expect(container.textContent).toContain('Do primeiro passo');

    const rendersBeforeRetry = harness.stageRenders;
    const retry = container.querySelector<HTMLButtonElement>('.hand-stage-fallback button');
    expect(retry).not.toBeNull();
    await act(async () => retry!.click());
    expect(harness.stageRenders).toBeGreaterThan(rendersBeforeRetry);
    expect(container.textContent).toContain('Não foi possível carregar a mão em 3D.');
  }, 10000);
});
