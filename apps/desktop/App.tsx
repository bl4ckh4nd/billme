import { createDesktopApp } from '@billme/desktop-renderer/createDesktopApp';
import { AppRouterProvider } from './router';
import { ErrorBoundary } from './components/ErrorBoundary';

export default createDesktopApp(AppRouterProvider, ErrorBoundary);
