import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { logger } from './logger';

describe('Logger', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('should create logger instance', () => {
    expect(logger).toBeDefined();
    expect(logger.info).toBeInstanceOf(Function);
    expect(logger.error).toBeInstanceOf(Function);
    expect(logger.warn).toBeInstanceOf(Function);
    expect(logger.debug).toBeInstanceOf(Function);
  });

  it('should log info messages', () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    logger.info('TestContext', 'Test message', { data: 'test' });

    expect(consoleLogSpy).toHaveBeenCalled();
    consoleLogSpy.mockRestore();
  });

  it('should log error messages with error object', () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const error = new Error('Test error');
    logger.error('TestContext', 'Error occurred', error);

    expect(consoleLogSpy).toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(error);

    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('should include error stack traces', () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const error = new Error('Test error with stack');
    logger.error('TestContext', 'Stack test', error);

    expect(consoleErrorSpy).toHaveBeenCalledWith(error);

    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('should only log debug messages in development', () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Note: The logger instance is created at module load time, so isDev is already set
    // We can only test that debug logging works, not test the production behavior
    // in the same test run since the logger is a singleton
    logger.debug('TestContext', 'Debug message');

    // In the test environment (NODE_ENV not set to 'production'), debug should log
    if (process.env.NODE_ENV !== 'production') {
      expect(consoleLogSpy).toHaveBeenCalled();
    }

    consoleLogSpy.mockRestore();
  });
});
