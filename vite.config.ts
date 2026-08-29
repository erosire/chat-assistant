// Vite configuration mirrors distribution/story-generator/vite.config.ts so
// the assistant can be developed and deployed as an independent distribution.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// API URL strategy: the UI's defaults are ABSOLUTE. DEFAULT_CHAT_ASSISTANT_URL
// (src/api/chat-assistant.ts) pins the storage origin
// http://192.168.8.128:5000 (DATABASE port, via DEFAULT_SERVER_URL in
// src/api/server-url.ts), and DEFAULT_PROVIDER_URL (src/api/provider.ts) pins
// the provider origin http://192.168.8.128:5500 (PROVIDER port, via
// INFERENCE_PROVIDER_URL in src/api/config.ts) — the runtime /providers/private
// routes bind LOCAL_AREA_NETWORK_PROVIDER_PORT, so the browser always talks
// straight to the LAN backends regardless of where the static build is hosted.
// A previous revision used origin-relative paths with a dev-server proxy to
// localhost:5000; that proxy was REMOVED because (a) the app no longer issues
// relative-path requests so nothing would hit it, and (b) origin-relative
// requests resolve against the STATIC host on GitHub Pages (github.io serves
// no API routes) and 404 there — the bug this fixes.

// Relative assets keep the build usable from a GitHub Pages repository path.
export default defineConfig({
    plugins: [react()],
    base: './',
    server: {
        port: 4500,
        // Never watch the service's shared writable data root: chokidar
        // holding files under temporary/database while the underload service
        // writes them surfaces as sporadic EPERM failures on Windows.
        watch: {
            ignored: ['**/temporary/**']
        }
    },
    build: {
        outDir: 'dist'
    }
});
