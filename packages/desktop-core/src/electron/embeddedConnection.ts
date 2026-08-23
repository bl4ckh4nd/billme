import {
  EMBEDDED_CONNECTION_CHANNEL,
  embeddedConnectionResultSchema,
  type EmbeddedConnectionResult,
} from '@billme/desktop-contracts/embeddedConnection';

export type EmbeddedConnectionInvoke = () => Promise<unknown>;
export type EmbeddedConnectionResolver = () => Promise<EmbeddedConnectionResult>;

export type EmbeddedConnectionIpcEvent = { sender: unknown };
export type EmbeddedConnectionIpcHandler = (event: EmbeddedConnectionIpcEvent) => Promise<EmbeddedConnectionResult>;
export type EmbeddedConnectionIpcMain = {
  handle: (channel: string, handler: EmbeddedConnectionIpcHandler) => void;
  removeHandler?: (channel: string) => void;
};

export type EmbeddedConnectionRegistrationOptions = {
  resolveConnection: () => unknown | Promise<unknown>;
  isTrustedSender: (sender: unknown) => boolean;
  channel?: string;
};

export const createEmbeddedConnectionResolver = (
  invoke: EmbeddedConnectionInvoke,
): EmbeddedConnectionResolver => {
  let cached: Promise<EmbeddedConnectionResult> | undefined;

  return () => {
    cached ??= Promise.resolve().then(invoke).then((payload) => embeddedConnectionResultSchema.parse(payload));
    return cached;
  };
};

export const registerEmbeddedConnectionHandler = (
  ipcMain: EmbeddedConnectionIpcMain,
  options: EmbeddedConnectionRegistrationOptions,
): (() => void) => {
  const channel = options.channel ?? EMBEDDED_CONNECTION_CHANNEL;
  const handler: EmbeddedConnectionIpcHandler = async (event) => {
    if (!options.isTrustedSender(event.sender)) {
      throw new Error('Nicht vertrauenswürdiger WebContents-Sender.');
    }
    return embeddedConnectionResultSchema.parse(await options.resolveConnection());
  };

  ipcMain.handle(channel, handler);
  return () => ipcMain.removeHandler?.(channel);
};
