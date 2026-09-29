import { createProHttpBillmeApi, type ProHttpBillmeApi } from '@billme/desktop-services/proHttpApi';
import type { IpcInvoke } from '@billme/desktop-contracts-pro/api';
import { createBrowserNativeFallback } from '@billme/desktop-renderer/browser-native-fallback';

export type ProWebApiOptions = {
  baseUrl: string;
  token: string;
  onRequestClose?: () => void;
};

export const createProWebBillmeApi = ({ baseUrl, token, onRequestClose }: ProWebApiOptions): ProHttpBillmeApi =>
  createProHttpBillmeApi({
    baseUrl,
    getToken: () => token,
    fallback: createBrowserNativeFallback<IpcInvoke>('Billme Pro', onRequestClose),
  });
