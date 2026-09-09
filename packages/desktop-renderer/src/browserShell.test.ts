// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { getInitialBrowserApiUrl } from './browserShell';

describe('getInitialBrowserApiUrl', () => {
  afterEach(() => {
    window.localStorage.clear();
    delete (window as Window & { billmeRuntimeConfig?: unknown }).billmeRuntimeConfig;
  });

  it('uses stored, build-time and host-derived API URLs in that order', () => {
    expect(getInitialBrowserApiUrl({ defaultApiUrl: 'https://api.example.test' })).toBe('https://api.example.test');

    window.localStorage.setItem('billme.api', 'https://stored.example.test');
    expect(getInitialBrowserApiUrl({
      apiUrlStorageKey: 'billme.api',
      defaultApiUrl: 'https://api.example.test',
    })).toBe('https://stored.example.test');

    (window as Window & { billmeRuntimeConfig?: { serverApiUrl?: string } }).billmeRuntimeConfig = {
      serverApiUrl: 'https://runtime.example.test',
    };
    expect(getInitialBrowserApiUrl({
      apiUrlStorageKey: 'billme.api',
      defaultApiUrl: 'https://api.example.test',
    })).toBe('https://runtime.example.test');
  });
});
