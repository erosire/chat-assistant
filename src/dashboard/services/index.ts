// Service barrel for the dashboard plugin layer.
//
// Everything a chat plugin needs from the assistant's data layer, behind one
// import path and with no React anywhere in these modules: the mode-aware
// conversation store, the streaming provider client, the voice-input client and
// the agent/tool registries. Each entry is a plain factory returning a plain
// object, so the values plug straight into a dashboard `services` capability
// registration without this package importing the dashboard framework at all.
//
// Two api constants are re-exported because plugin feature parity needs them and
// they carry no logic: `CONVERSATION_POLL_INTERVAL_MS` (the cadence for polling
// an in-flight 'pending' conversation) and `appendTranscript` (the composer
// draft-merge rule for a spoken turn).
export * from './conversations';
export * from './provider';
export * from './registries';
export * from './speech';

export { CONVERSATION_POLL_INTERVAL_MS } from '../../api/chat-assistant';
export { appendTranscript } from '../../api/speech';
