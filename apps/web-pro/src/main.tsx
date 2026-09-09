import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '../../pro-desktop/index.css';
import '@billme/accounting-ui-pro/styles.css';
import './styles.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Could not find root element');
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
