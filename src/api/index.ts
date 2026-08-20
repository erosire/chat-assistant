// API barrel keeps browser callers independent from the wire-format module path.
// chat-assistant = pure conversation storage; provider = runtime model endpoints
// (models catalog + chat completions) consumed directly by the UI with no API key.
// server-url = absolute backend origin both defaults are pinned to (static
// hosts like GitHub Pages serve no API routes, so relative paths 404 there).
// config = raw host/port for the database API server and inference provider
// (single source of truth the assembled URLs in server-url/provider derive from).
// speech = Web Speech API wrapper (feature probe, session handle, transcript
// append + error label) for the composer's voice-to-text toggle.
export * from './config';
export * from './chat-assistant';
export * from './provider';
export * from './server-url';
export * from './speech';
