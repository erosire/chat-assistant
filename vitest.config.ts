// Vitest configuration uses jsdom because the package contains a React chat UI.
import { defineConfig } from 'vitest/config';

// Keep test discovery scoped to this distribution package.
export default defineConfig({
    test: {
        environment: 'jsdom',
        globals: true,
        include: ['src/**/*.{test,spec}.{ts,tsx}'],
        passWithNoTests: true
    }
});
