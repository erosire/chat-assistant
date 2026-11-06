// Voice-input SERVICE facade for the dashboard plugins.
//
// WHAT THIS IS: a promise-first wrapper around the Web Speech API session in
// ../../api/speech.ts. The engine lifecycle stays exactly where it is — the
// per-start fresh instance, the cumulative transcript recomputation, the
// exactly-once settlement guard, the benign-ending suppression ('no-speech' /
// 'aborted' never reach a callback) and the vendor-prefix probe are all owned
// by that module and are NOT duplicated here.
//
// THE THREE MAPPING DECISIONS:
//   1. `onTranscript(text, final)` (the api's CUMULATIVE frame contract) splits
//      into `onInterim(text)` while the utterance is still forming and
//      `onFinal(text)` for the settled utterance — each frame reaches exactly
//      one handler, so a plugin never has to branch on a boolean.
//   2. `onError(message)` receives the display-ready strings api/speech.ts
//      already produces (`speechErrorLabel` for live engine failures).
//   3. `start()` REJECTS when no session could be created at all, with the
//      actionable diagnostics api/speech.ts exposes: the missing-API message
//      when the browser ships no constructor, and `speechDeniedDetail()`'s
//      HTTPS/localhost explanation when the page is not a secure context (the
//      "works on the desktop, detects nothing on the phone" trap documented in
//      api/speech.ts:73-94 — pre-checking it avoids a silently doomed session).
//      Errors raised by a session that DID start are delivered to
//      `handlers.onError`, never to both paths, so a plugin has one obvious
//      place to render a message.
import {
    createSpeechRecognizer,
    speechContextSecure,
    speechDeniedDetail,
    speechRecognitionSupported,
    type SpeechRecognizerHandle
} from '../../api/speech';

// One live recognition session. `stop` is a full teardown: it asks the engine
// to end AND detaches every engine callback, so nothing reaches the handlers
// afterwards (the api's `dispose()` contract, for the unmount path).
export interface SpeechHandle {
    stop(): void;
    // True from a successful start until the session settles — a final frame,
    // an engine error, an engine end, or `stop()`.
    readonly active: boolean;
}

// Callbacks for one session. All three receive ready-to-display strings.
export interface SpeechClientHandlers {
    // Partial transcript for the utterance still being spoken (cumulative).
    onInterim(text: string): void;
    // Settled transcript for the utterance (cumulative); the session ends right
    // after this frame, mirroring api/speech.ts:248-254.
    onFinal(text: string): void;
    // A real failure (denied permission, missing microphone, network). Benign
    // endings never fire it.
    onError(message: string): void;
}

// The voice-input contract every chat plugin consumes.
export interface SpeechClient {
    // Whether this browser exposes the recognition API at all (false → the
    // plugin renders plain typing only, never a dead microphone button).
    available(): Promise<boolean>;
    start(handlers: SpeechClientHandlers): Promise<SpeechHandle>;
}

// The API-less environment message: jsdom, Firefox and any SSR bootstrap take
// this path, and the composer's degradation rule is the same
// (api/speech.ts:70-71 plus components/ChatAssistantApp.tsx's toggle guard).
const SPEECH_UNSUPPORTED =
    'Voice input is not available: this browser does not expose the Web Speech recognition API (Chrome and Edge do; Firefox and embedded webviews generally do not).';

// Build the voice-input client. There is no configuration: the engine inherits
// the page language (`navigator.language`) through api/speech.ts, exactly like
// the shipped composer.
export function createSpeechClient(): SpeechClient {
    return {
        available: async (): Promise<boolean> => speechRecognitionSupported(),

        start: async (handlers: SpeechClientHandlers): Promise<SpeechHandle> => {
            if (!speechRecognitionSupported()) throw new Error(SPEECH_UNSUPPORTED);

            // Insecure-context pre-check: `start()` would "succeed", show no
            // prompt and end benignly, so the user would see NOTHING. Rejecting
            // with the diagnosed fix is the actionable alternative the composer
            // already uses (api/speech.ts:139-164).
            if (!speechContextSecure()) throw new Error(await speechDeniedDetail());

            // Session liveness mirrors the api handle: it flips false on the
            // first terminal path, which is also the last callback delivery.
            let active = false;

            // Fresh recognizer per start (api/speech.ts:196-200): the engine
            // object holds per-instance state and is never reused across taps.
            const recognizer: SpeechRecognizerHandle = createSpeechRecognizer({
                onTranscript: (transcript: string, final: boolean): void => {
                    if (final) handlers.onFinal(transcript);
                    else handlers.onInterim(transcript);
                },
                onError: (detail: string): void => {
                    // The api fires onError then settles the session, so
                    // `active` is already false via onEnd; assigning twice is
                    // idempotent and keeps the flag honest if an engine skips
                    // the end event.
                    active = false;
                    handlers.onError(detail);
                },
                onEnd: (): void => {
                    active = false;
                }
            });

            // False here means the engine vanished between the probe and the
            // start (lazy unload): the same unsupported outcome as above.
            if (!recognizer.start()) throw new Error(SPEECH_UNSUPPORTED);
            active = true;

            return {
                stop: (): void => {
                    if (!active) return;
                    // stop() asks the engine to end; dispose() then detaches
                    // the callbacks so a late terminal event cannot reach a
                    // handler whose owner already moved on. The flag is cleared
                    // here because dispose() suppresses the onEnd delivery.
                    recognizer.stop();
                    recognizer.dispose();
                    active = false;
                },
                get active(): boolean {
                    return active;
                }
            };
        }
    };
}
