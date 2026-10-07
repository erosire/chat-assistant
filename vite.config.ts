// Vite configuration mirrors distribution/story-generator/vite.config.ts so
// the assistant can be developed and deployed as an independent distribution.
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Application version: read once from this distribution's package.json and
// injected as the `__APP_VERSION__` define so the UI (src/version.ts) never
// carries a hardcoded duplicate of the "version" field. A plain global define
// (rather than `import.meta.env.APP_VERSION`) is used because vitest's runtime
// rewrites `import.meta.env` access, which silently swallows env-scoped defines
// during test runs; a plain identifier is substituted by esbuild identically
// in the vite build, the dev server, and vitest.
const APP_VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')).version as string;

// API URL strategy: the UI's defaults are ABSOLUTE. DEFAULT_CHAT_ASSISTANT_URL
// (src/api/chat-assistant.ts) pins the storage origin
// http://192.168.50.109:5000 (DATABASE port, via DEFAULT_SERVER_URL in
// src/api/server-url.ts), and DEFAULT_PROVIDER_URL (src/api/provider.ts) pins
// the provider origin http://192.168.50.109:5500 (PROVIDER port, via
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
    // Pin the package.json version into the bundle (see the APP_VERSION note
    // above) — mirrors the define in vitest.config.ts so tests assert the
    // same value the shipped UI renders.
    define: {
        __APP_VERSION__: JSON.stringify(APP_VERSION)
    },
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
