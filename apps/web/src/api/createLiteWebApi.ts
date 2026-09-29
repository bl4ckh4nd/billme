import { createLiteHttpBillmeApi, type LiteHttpBillmeApi } from '@billme/desktop-services/liteHttpApi';
import type { IpcInvoke } from '@billme/desktop-contracts/api';
import { createBrowserNativeFallback } from '@billme/desktop-renderer/browser-native-fallback';

export type LiteWebApiOptions = {
  baseUrl: string;
  token: string;
  onAuthFailure?: () => void;
  onRequestClose?: () => void;
};

export const createLiteWebBillmeApi = ({ baseUrl, token, onAuthFailure, onRequestClose }: LiteWebApiOptions): LiteHttpBillmeApi =>
  createLiteHttpBillmeApi({
    baseUrl,
    auth: { mode: 'bearer', token },
    onAuthFailure,
    fallback: createBrowserNativeFallback<IpcInvoke>('Billme Lite', onRequestClose),
  });
