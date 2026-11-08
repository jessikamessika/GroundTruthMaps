import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Multi-page build that keeps the public URLs the live site already uses
// (QR codes, emails and PWA manifests point at them):
//   /                    -> redirect to web/
//   /web/                -> the map
//   /web/privacy.html    -> privacy notice + opt-out
//   /thesis/             -> thesis summary page
// Static files that must keep fixed names (data, icons, manifests, the
// vendored PostHog SDK) live in public/ and are copied as-is.
// base './' keeps every URL relative, so the same build works at
// http://localhost:5173/ and at https://jessikamessika.github.io/GroundTruthMaps/.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,   // maplibre + turf are large by nature
    rollupOptions: {
      input: {
        redirect: resolve(import.meta.dirname, 'index.html'),
        map: resolve(import.meta.dirname, 'web/index.html'),
        privacy: resolve(import.meta.dirname, 'web/privacy.html'),
        thesis: resolve(import.meta.dirname, 'thesis/index.html'),
      },
    },
  },
  // Port 8000: the ORS and construction Workers (api/workers/) only accept
  // requests from localhost:8000 / 127.0.0.1:8000 besides the live site.
  // MapLibre 6 loads its worker via new URL('./maplibre-gl-worker.mjs', import.meta.url);
  // pre-bundling moves the file and breaks that URL, so serve it as-is.
  optimizeDeps: { exclude: ['maplibre-gl'] },
  // host: true listens on all interfaces so a phone on the same Wi-Fi can connect.
  server: { host: true, port: 8000, strictPort: true, open: '/web/' },
  preview: { host: true, port: 8000, strictPort: true, open: '/web/' },
});
