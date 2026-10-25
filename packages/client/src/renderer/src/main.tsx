import { createRoot } from 'react-dom/client';
import '@fontsource-variable/figtree';
import './styles/base.css';
import './styles/app.css';
import './styles/settings.css';
import './styles/mobile.css';
import { App } from './App';
import { installLongPressMenus, registerServiceWorker, trackViewportHeight } from './lib/web';

createRoot(document.getElementById('root')!).render(<App />);
registerServiceWorker();
installLongPressMenus();
trackViewportHeight();
