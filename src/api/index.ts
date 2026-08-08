// API barrel keeps browser callers independent from the wire-format module path.
// chat-assistant = pure conversation storage; provider = runtime model endpoints
// (models catalog + chat completions) consumed directly by the UI with no API key.
export * from './chat-assistant';
export * from './provider';
