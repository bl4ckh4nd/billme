// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserNativeFallback } from './createBrowserNativeFallback';

describe('createBrowserNativeFallback', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/pro');
    vi.restoreAllMocks();
  });

  it('returns authenticated print URLs for document and EÜR exports', async () => {
    const invoke = createBrowserNativeFallback();

    await expect(invoke('pdf:export', { kind: 'invoice', id: 'inv-1' })).resolves.toMatchObject({
      path: 'http://localhost:3000/pro?__print=1&__autoprint=1&kind=invoice&id=inv-1',
    });
    await expect(invoke('eur:exportPdf', { taxYear: 2025 })).resolves.toMatchObject({
      path: 'http://localhost:3000/pro?__print=1&__autoprint=1&kind=eur&taxYear=2025',
    });
  });

  it('does not fake unavailable desktop persistence', async () => {
    const invoke = createBrowserNativeFallback();

    await expect(invoke('db:backup', undefined)).rejects.toThrow('nicht verfügbar');
    await expect(invoke('secrets:set', { key: 'smtp.password', value: 'secret' })).rejects.toThrow(
      'sichere Ablage',
    );
  });

  it('opens only browser-safe URLs', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const invoke = createBrowserNativeFallback();

    await invoke('shell:openExternal', { url: 'https://example.com/help' });
    expect(open).toHaveBeenCalledWith('https://example.com/help', '_blank', 'noopener,noreferrer');
    await expect(invoke('shell:openExternal', { url: 'file:///etc/passwd' })).rejects.toThrow('nicht sicher');
  });
});
