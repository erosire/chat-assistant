// Single source of truth for the application version of this distribution:
// the "version" field of distribution/chat-assistant/package.json.
//
// vite.config.ts and vitest.config.ts read that field and inject it as the
// `__APP_VERSION__` define (esbuild substitutes the identifier in the vite
// build, the dev server, and vitest — plain globals survive all three,
// whereas `import.meta.env.*` defines get swallowed by vitest's runtime env).
// No hardcoded duplicate of the version ever lives in the UI source;
// `tsc --noEmit` typechecks because the identifier is declared below, and the
// typeof guard keeps this module safe in any context that skips the define.
declare const __APP_VERSION__: string;

export const APP_VERSION: string =
    typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';

// The branded product title shown by the header fallback (components/
// ChatAssistantApp.tsx) and set as the browser document title (main.tsx):
// "Chat Assistant v<version>".
export const PRODUCT_TITLE = `Chat Assistant v${APP_VERSION}`;
