import { mountDesktopRendererApp } from '@billme/desktop-renderer';
import { demoHttpApi } from './ipcHttp';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Could not find root element to mount demo app');
}

void mountDesktopRendererApp(rootElement, { api: demoHttpApi });
