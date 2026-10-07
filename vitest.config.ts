// Vitest configuration uses jsdom because the package contains a React chat UI.
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Mirror vite.config.ts's `__APP_VERSION__` define so the tests resolve the
// application version from the same single source (this distribution's
// package.json) the shipped bundle does — see src/version.ts. A plain global
// define is used (not `import.meta.env.APP_VERSION`) because vitest's runtime
// materializes `import.meta.env` and swallows env-scoped defines in test runs.
const APP_VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')).version as string;

// Keep test discovery scoped to this distribution package.
export default defineConfig({
    define: {
        __APP_VERSION__: JSON.stringify(APP_VERSION)
    },
    test: {
        environment: 'jsdom',
        globals: true,
        include: ['src/**/*.{test,spec}.{ts,tsx}'],
        passWithNoTests: true
    }
});
