import { createRoot } from 'react-dom/client';
import 'maplibre-gl/dist/maplibre-gl.css';
import './map.css';

import { CITY, SRC } from '../core/config.js';
import { phInit } from '../core/analytics.js';
import App from './App.jsx';

if (CITY.key === 'sf') document.querySelector('link[rel="manifest"]').href = './manifest-sf.webmanifest';
document.title = CITY.name + ' Cycling Closures Map';

// Usage statistics (src/core/analytics.js). Loads nothing without a key, with
// DNT/GPC, or after opt-out on the privacy page. src: booth-* or 'none'.
try { phInit({ city: CITY.key, src: SRC }); }
catch (e) { console.error('[analytics] init failed', e); }

createRoot(document.getElementById('root')).render(<App />);
