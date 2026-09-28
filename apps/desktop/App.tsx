import { createDesktopApp } from '@billme/desktop-renderer/createDesktopApp';
import { AppRouterProvider } from './router';
import { ErrorBoundary } from '@billme/desktop-ui';

export default createDesktopApp(AppRouterProvider, ErrorBoundary);
