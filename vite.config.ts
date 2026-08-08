// Vite configuration mirrors distribution/story-generator/vite.config.ts so
// the assistant can be developed and deployed as an independent distribution.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The UI uses origin-relative API URLs (DEFAULT_PROVIDER_URL = '/providers/private/v1'
// and DEFAULT_CHAT_ASSISTANT_URL = '/v1/chat-assistant/conversation' in src/api).
// During `vite dev` those paths would resolve against this dev server (port 8001),
// which serves no API routes, so the model catalog request 404s and the dropdown
// reports "No models available". Proxying both prefixes to the local service
// (chat-assistant.yml server: http://127.0.0.1:5000) keeps the relative defaults
// working in dev and in same-origin deployments without any code override.
const API_TARGET = 'http://localhost:5000';

// Relative assets keep the build usable from a GitHub Pages repository path.
export default defineConfig({
    plugins: [react()],
    base: './',
    server: {
        port: 8001,
        proxy: {
            // Runtime provider endpoints: /providers/private/v1/models and
            // /providers/private/v1/chat/completions (runtime/endpoint/provider).
            '/providers': { target: API_TARGET, changeOrigin: true },
            // Conversation storage endpoints owned by this distribution.
            '/v1/chat-assistant': { target: API_TARGET, changeOrigin: true }
        }
    },
    build: {
        outDir: 'dist'
    }
});
