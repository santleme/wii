import { describe, expect, it } from 'vitest';
import { preferredDelegate } from '../src/cv/delegate';
import { diagnosticsEnabled } from '../src/cv/diagnostics/flags';

describe('vision delegate', () => {
  it('defaults to the CPU and only uses the GPU when asked', () => {
    expect(preferredDelegate('')).toBe('CPU');
    expect(preferredDelegate('?delegate=gpu')).toBe('GPU');
  });

  it('keeps the diagnostic keys away from visitors of a production build', () => {
    expect(diagnosticsEnabled('', false)).toBe(false);
    expect(diagnosticsEnabled('?debug', false)).toBe(true);
    expect(diagnosticsEnabled('?fotos', false)).toBe(true);
    expect(diagnosticsEnabled('', true)).toBe(true);
  });
});
