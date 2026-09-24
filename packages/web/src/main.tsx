import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.tsx';
import { LangProvider } from './i18n.tsx';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('no #root element');

createRoot(root).render(
  <StrictMode>
    <LangProvider>
      <App />
    </LangProvider>
  </StrictMode>,
);
