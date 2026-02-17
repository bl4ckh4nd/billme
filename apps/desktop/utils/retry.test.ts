import { describe, it, expect, vi } from 'vitest';
import { withRetry, shouldRetryNetworkError } from './retry';

describe('withRetry', () => {
  it('should succeed on first attempt', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    const result = await withRetry(fn, { delayMs: 10 });

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on failure and eventually succeed', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('success');

    const result = await withRetry(fn, { maxAttempts: 3, delayMs: 10 });

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should respect maxAttempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    await expect(withRetry(fn, { maxAttempts: 3, delayMs: 10 })).rejects.toThrow('fail');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should use exponential backoff', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('success');

    const startTime = Date.now();
    await withRetry(fn, { maxAttempts: 3, delayMs: 100 });
    const endTime = Date.now();

    // Should wait at least 100ms (first retry) + 200ms (second retry) = 300ms
    expect(endTime - startTime).toBeGreaterThanOrEqual(300);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should respect maxDelayMs', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('success');

    const startTime = Date.now();
    await withRetry(fn, { maxAttempts: 2, delayMs: 10000, maxDelayMs: 100 });
    const endTime = Date.now();

    // Should be capped at maxDelayMs (100ms), not delayMs (10000ms)
    expect(endTime - startTime).toBeLessThan(500);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should respect shouldRetry predicate', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('auth failed'));

    await expect(
      withRetry(fn, {
        maxAttempts: 3,
        delayMs: 10,
        shouldRetry: (error) => {
          // Don't retry auth errors
          return !(error instanceof Error && error.message.includes('auth'));
        },
      })
    ).rejects.toThrow('auth failed');

    // Should only attempt once, not retry
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should call onRetry callback', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('success');

    const onRetry = vi.fn();

    await withRetry(fn, { maxAttempts: 2, delayMs: 10, onRetry });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error));
  });
});

describe('shouldRetryNetworkError', () => {
  it('should retry on ETIMEDOUT', () => {
    expect(shouldRetryNetworkError(new Error('ETIMEDOUT'))).toBe(true);
  });

  it('should retry on ECONNREFUSED', () => {
    expect(shouldRetryNetworkError(new Error('ECONNREFUSED'))).toBe(true);
  });

  it('should retry on ENOTFOUND', () => {
    expect(shouldRetryNetworkError(new Error('ENOTFOUND'))).toBe(true);
  });

  it('should retry on network error', () => {
    expect(shouldRetryNetworkError(new Error('network timeout'))).toBe(true);
  });

  it('should retry on socket error', () => {
    expect(shouldRetryNetworkError(new Error('socket hang up'))).toBe(true);
  });

  it('should not retry on auth errors', () => {
    expect(shouldRetryNetworkError(new Error('Invalid credentials'))).toBe(false);
  });

  it('should not retry on validation errors', () => {
    expect(shouldRetryNetworkError(new Error('Invalid email address'))).toBe(false);
  });

  it('should not retry on non-Error objects', () => {
    expect(shouldRetryNetworkError('string error')).toBe(false);
    expect(shouldRetryNetworkError({ error: 'object' })).toBe(false);
    expect(shouldRetryNetworkError(null)).toBe(false);
  });

  it('should be case insensitive', () => {
    expect(shouldRetryNetworkError(new Error('Network Timeout'))).toBe(true);
    expect(shouldRetryNetworkError(new Error('NETWORK ERROR'))).toBe(true);
  });
});
