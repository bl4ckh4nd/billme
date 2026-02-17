import { logger } from '../utils/logger';

export function wrapIpcHandler<TArgs, TResult>(
  route: string,
  handler: (args: TArgs) => Promise<TResult>
): (args: TArgs) => Promise<TResult> {
  return async (args: TArgs): Promise<TResult> => {
    try {
      logger.debug('IPC', `Handler called: ${route}`, { args });
      const result = await handler(args);
      logger.debug('IPC', `Handler completed: ${route}`);
      return result;
    } catch (error) {
      logger.error('IPC', `Handler failed: ${route}`, error as Error, { args });
      throw error; // Re-throw to propagate to renderer
    }
  };
}
