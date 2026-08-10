// API barrel keeps browser callers independent from the wire-format module path.
// chat-assistant = pure conversation storage; provider = runtime model endpoints
// (models catalog + chat completions) consumed directly by the UI with no API key.
// server-url = absolute backend origin both defaults are pinned to (static
// hosts like GitHub Pages serve no API routes, so relative paths 404 there).
export * from './chat-assistant';
export * from './provider';
export * from './server-url';
