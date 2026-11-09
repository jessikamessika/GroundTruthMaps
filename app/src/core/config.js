// City settings and URL parameters, read once at page load.

export const CITIES = {
  calgary: {
    key: 'calgary', name: 'Calgary', center: [-114.0719, 51.0447], zoom: 11,
    timezone: 'America/Edmonton',
    // Relative to /web/: resolves to /data/ in dev and /GroundTruthMaps/data/ on Pages.
    dataDir: '../data', network: true, construction: true,
    // HTML: MapLibre's attribution control renders this as markup.
    attribution: 'City of Calgary Open Data (<a href="https://data.calgary.ca/stories/s/Open-Calgary-Terms-of-Use/u45n-7awa" target="_blank" rel="noopener">Open Government Licence - Calgary</a>)',
  },
  sf: {
    key: 'sf', name: 'San Francisco', center: [-122.4194, 37.7749], zoom: 12,
    timezone: 'America/Los_Angeles',
    dataDir: '../data/sf', network: false, construction: false,
    attribution: 'SFMTA Temporary Street Closures via DataSF',
  },
};

const params = new URLSearchParams(location.search);

export const CITY = CITIES[params.get('city')] || CITIES.calgary;
export const IS_CALGARY = CITY === CITIES.calgary;

// Entry channel (?src=booth-qr | booth-nfc | booth-form), stored with each sign-up.
// Booth visitors skip the welcome card and land straight in route planning.
export const SRC = (params.get('src') || 'direct').slice(0, 40);
export const BOOTH = SRC.startsWith('booth-') && IS_CALGARY;
export const VENUE = { center: [-114.0575156, 51.044078], zoom: 12 };   // booth venue
export const PITCH = 'Is your route closed? Find out in 10 seconds.';

export const SMALL_SCREEN = window.matchMedia('(max-width: 600px)');

// Third-party endpoints
export const ORS_PROXY_URL = 'https://ors-proxy.jess-jm-zhang.workers.dev';
export const CONSTR_URL = 'https://construction-proxy.jess-jm-zhang.workers.dev/';
export const SIGNUP_URL = 'https://script.google.com/macros/s/AKfycbxJ7UAYDDpUQCGJ8hSNmVkuEXa4L6TofjYZ_7aqJnfvquSm4e0TfWCoDQ2z4I3DZAY/exec';   // Apps Script web app (api/apps-script/signup.gs)
export const PRIVACY_URL = 'https://jessikamessika.github.io/GroundTruthMaps/web/privacy.html';
export const CONTACT_EMAIL = 'jess.jm.zhang@gmail.com';

// Data files fetched by the map (api/scraping writes them into app/public/data/)
export const CLOSURES_URL = CITY.dataDir + '/closures.geojson';
export const NETWORK_URL = CITY.dataDir + '/network.geojson';

// Credits shown behind the map's "i" button (OpenStreetMap ODbL + city source).
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors (ODbL)';
// Wording required by https://account.heigit.org/info/tos ("Attribution and License").
export const ORS_ATTRIBUTION = '© openrouteservice by HeiGIT | Data from OpenStreetMap';
