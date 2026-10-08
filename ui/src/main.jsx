import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(<App />);
// installable as an app (a service worker that intercepts nothing: see public/sw.js); only on https or localhost
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
