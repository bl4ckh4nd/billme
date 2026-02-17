import { logger } from './logger';

export interface RetryOptions {
  maxAttempts?: number;
  delayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (error: unknown) => boolean;
  onRetry?: (attempt: number, error: unknown) => void;
  context?: string;
}

const defaultOptions: Required<RetryOptions> = {
  maxAttempts: 3,
  delayMs: 1000,
  maxDelayMs: 10000,
  shouldRetry: () => true,
  onRetry: () => {},
  context: 'Retry',
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...defaultOptions, ...options };
  let lastError: unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === opts.maxAttempts || !opts.shouldRetry(error)) {
        throw error;
      }

      const delay = Math.min(opts.delayMs * Math.pow(2, attempt - 1), opts.maxDelayMs);

      logger.warn(opts.context, `Attempt ${attempt}/${opts.maxAttempts} failed, retrying in ${delay}ms`, {
        error: error instanceof Error ? error.message : String(error),
      });

      opts.onRetry(attempt, error);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

// Helper for SMTP/network errors
export function shouldRetryNetworkError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    // Retry on network/timeout errors, not on auth/validation errors
    return (
      message.includes('timeout') ||
      message.includes('econnrefused') ||
      message.includes('enotfound') ||
      message.includes('etimedout') ||
      message.includes('network') ||
      message.includes('socket')
    );
  }
  return false;
}

/**
 * Determine if an email error is retryable
 * Used for dunning retry logic
 */
export function isRetryableEmailError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();

    // Retryable (network/transient issues)
    if (msg.includes('timeout')) return true;
    if (msg.includes('econnrefused')) return true;
    if (msg.includes('enotfound')) return true;
    if (msg.includes('etimedout')) return true;
    if (msg.includes('network')) return true;
    if (msg.includes('socket')) return true;
    if (msg.includes('5')) return true; // 5xx server errors

    // Permanent (auth/validation issues)
    if (msg.includes('authentication')) return false;
    if (msg.includes('credentials')) return false;
    if (msg.includes('invalid email')) return false;
    if (msg.includes('recipient')) return false;
    if (msg.includes('4')) return false; // 4xx client errors
  }

  return false; // Unknown errors → don't retry by default
}
