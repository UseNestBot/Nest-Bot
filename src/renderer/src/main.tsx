import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { StoreProvider } from './store';
import './styles.css';
import { ConfirmHost } from './components/confirm';
import { RemoteGate } from './web/RemoteGate';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RemoteGate>
      <StoreProvider>
        <App />
        <ConfirmHost />
      </StoreProvider>
    </RemoteGate>
  </StrictMode>,
);
