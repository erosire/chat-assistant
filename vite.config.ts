// Vite configuration mirrors distribution/story-generator/vite.config.ts so
// the assistant can be developed and deployed as an independent distribution.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative assets keep the build usable from a GitHub Pages repository path.
export default defineConfig({
    plugins: [react()],
    base: './',
    server: {
        port: 8001
    },
    build: {
        outDir: 'dist'
    }
});
