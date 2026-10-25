import { createRoot } from 'react-dom/client';
import '@fontsource-variable/figtree';
import './styles/base.css';
import './styles/app.css';
import './styles/settings.css';
import { App } from './App';
import { registerServiceWorker } from './lib/web';

createRoot(document.getElementById('root')!).render(<App />);
registerServiceWorker();
