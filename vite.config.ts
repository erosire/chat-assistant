// Vite configuration mirrors distribution/story-generator/vite.config.ts so
// the assistant can be developed and deployed as an independent distribution.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// API URL strategy: the UI's defaults are ABSOLUTE (DEFAULT_PROVIDER_URL and
// DEFAULT_CHAT_ASSISTANT_URL in src/api are built from DEFAULT_SERVER_URL =
// http://192.168.8.128:5000 in src/api/server-url.ts), so the browser always
// talks straight to the LAN backend regardless of where the static build is
// hosted. A previous revision used origin-relative paths with a dev-server
// proxy to localhost:5000; that proxy was REMOVED because (a) the app no
// longer issues relative-path requests so nothing would hit it, and (b)
// origin-relative requests resolve against the STATIC host on GitHub Pages
// (github.io serves no API routes) and 404 there — the bug this fixes.

// Relative assets keep the build usable from a GitHub Pages repository path.
export default defineConfig({
    plugins: [react()],
    base: './',
    server: {
        port: 4500
    },
    build: {
        outDir: 'dist'
    }
});
