import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/globals.css';
import { App } from './App';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element not found');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if (import.meta.env.DEV) {
  void import('web-vitals').then(({ onLCP, onINP, onCLS, onFCP, onTTFB }) => {
    const log = (m: { name: string; value: number }) => console.log(`[vitals] ${m.name}: ${m.value.toFixed(1)}`);
    onLCP(log); onINP(log); onCLS(log); onFCP(log); onTTFB(log);
  });
}
