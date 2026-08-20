// Voice-to-text for the chat composer (Web Speech API wrapper).
//
// PURPOSE: the ChatAssistantApp composer (src/components/ChatAssistantApp.tsx,
// ComposerField render site) gains a microphone toggle so users can talk to
// the assistant without typing. This module owns everything speech-specific;
// the component only renders the toggle and consumes three normalized hooks:
//
//   onTranscript(text, final) — the CUMULATIVE transcript from the session
//     start (interim while final=false, settled utterance when final=true).
//     The composer writes draft + transcript into the input state so the user
//     reviews/edits it; sending then works exactly like a typed message.
//   onError(detail)           — a real failure (denied permission, missing
//     microphone, network), delivered as the display-ready label from
//     speechErrorLabel. Benign endings (no-speech, aborted) never fire it.
//   onEnd()                   — the session terminated for ANY reason (final
//     result, explicit stop, error, benign ending). Fires EXACTLY ONCE per
//     started session (settle() below guards every engine terminal path).
//
// WHY A WRAPPER: the browser API is vendor-gated and untyped. Chrome/Edge
// expose window.SpeechRecognition, Safari exposes window.webkitSpeechRecognition,
// Firefox (and jsdom) expose neither. The composer degrades to plain typing
// where the API is missing (speechRecognitionSupported()). The DOM lib ships
// no SpeechRecognition types, so the minimal structural types below declare
// exactly the surface the wrapper touches.
import { stringSwitch } from '@presource/core';

// Minimal structural surface of the recognition API — only the members the
// wrapper reads/writes. `results` entries are indexable (alternative 0 is
// the highest-confidence transcript) and carry the per-group isFinal flag.
export interface ISpeechRecognitionAlternative {
    readonly transcript: string;
}
export interface ISpeechRecognitionResult {
    readonly isFinal: boolean;
    readonly [index: number]: ISpeechRecognitionAlternative | undefined;
}
export interface ISpeechRecognitionResultEvent {
    readonly resultIndex: number;
    readonly results: readonly ISpeechRecognitionResult[];
}
export interface ISpeechRecognitionErrorEvent {
    readonly error: string;
}
export interface ISpeechRecognition {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    maxAlternatives: number;
    onresult: ((event: ISpeechRecognitionResultEvent) => void) | null;
    onerror: ((event: ISpeechRecognitionErrorEvent) => void) | null;
    onend: (() => void) | null;
    start(): void;
    stop(): void;
}
type SpeechRecognitionConstructor = new () => ISpeechRecognition;

// Resolve the vendor-gated constructor: standard name first (Chrome/Edge),
// then the webkit-prefixed Safari fallback. `undefined` window (SSR / test
// bootstrap before globals) counts as unsupported.
const resolveRecognitionConstructor = (): SpeechRecognitionConstructor | null => {
    if (typeof window === 'undefined') return null;
    const globals = window as typeof window & {
        SpeechRecognition?: SpeechRecognitionConstructor;
        webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };
    return globals.SpeechRecognition ?? globals.webkitSpeechRecognition ?? null;
};

// Feature probe used by the composer to decide whether to offer the toggle
// action at all (false → a "not supported" error instead of a dead button).
export const speechRecognitionSupported = (): boolean => resolveRecognitionConstructor() !== null;

// Whether the page can even be GRANTED microphone access — i.e. whether it is
// a secure context. Browsers only show the mic permission prompt (and only let
// the recognition engine capture audio) in secure contexts: https, or
// loopback/localhost. A page served over plain HTTP from ANY other origin —
// most importantly a LAN/private IP viewed from a phone, e.g.
// `http://192.168.8.128:5173` — is NON-secure (window.isSecureContext === false).
//
// THIS is the "detects nothing on mobile but works on the desktop" trap:
// - `speechRecognitionSupported()` still returns TRUE there (real Chrome/Edge
//   expose the constructor even in a non-secure context), so the toggle looks
//   alive;
// - `start()` does NOT throw — it returns normally; no prompt is shown;
// - the engine then either fires `onerror:'not-allowed'` OR, on some engines
//   (and more often on mobile cloud-STT), just ends BENIGNLY (`no-speech` /
//   `aborted`) — both of which this wrapper treats as silent, so the user sees
//   NOTHING: the session opens, hears no audio, and quietly closes.
// Pre-checking here lets the composer surface the actionable
// HTTPS/localhost fix (via speechDeniedDetail) INSTEAD of starting a doomed
// session. `!== false` (not truthiness): engines that leave isSecureContext
// undefined must not be misreported as insecure.
export const speechContextSecure = (): boolean =>
    typeof window === 'undefined' || window.isSecureContext !== false;

// Engine error code → display label. codes without a label are not user
// errors: 'no-speech' (silence timed out) and 'aborted' (programmatic
// interrupt) end the session SILENTLY — the composer keeps whatever interim
// transcript is in the input and simply clears the listening state.
// stringSwitch dispatch: static labels pass through untouched, the default
// (unknown code) is a callback so it can embed the raw code it received.
export const speechErrorLabel = (code: string): string =>
    stringSwitch(code, {
        'not-allowed': 'Microphone access was denied.',
        'service-not-allowed': 'Microphone access was denied.',
        'audio-capture': 'No microphone was found.',
        network: 'Voice input failed: network problem.',
        'no-speech': '',
        aborted: '',
        default: ({ value }: { value: string }) => `Voice input failed: ${value}.`
    });

// Diagnose WHY the engine denied microphone access WITHOUT showing a prompt
// (the 'not-allowed' / 'service-not-allowed' codes — speechErrorLabel's
// display-ready 'Microphone access was denied.' banner hides the cause, so the
// composer swaps it for this self-diagnosis). The prompt is suppressed in
// three situations, in the order checked here:
//
// 1. INSECURE CONTEXT — the page is served over plain http on a non-localhost
//    origin (typical for LAN dev/static deployments, e.g. http://192.168.8.x:5000).
//    Browsers refuse microphone access SILENTLY here: window.isSecureContext
//    is false (it is only true for https or localhost) and the denial arrives
//    as 'not-allowed' with no dialog. Only serving over HTTPS (or localhost)
//    fixes this from the outside.
// 2. PREVIOUSLY DENIED SITE PERMISSION — the user picked "Block" (or an older
//    "Don't allow" decision lingers) for this origin: the prompt is never shown
//    again and the engine fails immediately. navigator.permissions.query
//    reports the sticky 'denied' state; the fix lives in the browser's site
//    settings (the address-bar icon), not on the page.
// 3. EVERYTHING ELSE — a permission policy blocking microphone on an embedded
//    iframe (allow="microphone" missing), an OS-level microphone exclusive
//    lock, or a managed policy. No probe reaches these from the page; the
//    fallback label names the two likely suspects.
//
// Async because (2) resolves through the Permissions API; every probe is
// guarded because jsdom, locked-down browsers, and SSR expose none of the
// surfaces (the helper then returns the generic label untouched — the caller
// can still display it).
export const speechDeniedDetail = async (): Promise<string> => {
    const generic = 'Microphone access was denied.';
    // Cause 1 (insecure context) is the check FIRST: in an insecure context the
    // Permissions API below may also report 'denied', but the actionable fix is
    // the HTTPS/localhost one, so it wins. `=== false` (not truthiness): an
    // undefined isSecureContext (older engines) must not misreport.
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
        return 'Microphone access is blocked: this page is not on HTTPS or localhost, so the browser denies the microphone silently without asking. Serve the page over HTTPS (or open it from localhost) to use voice input.';
    }
    // Cause 2 (sticky site denial): the query itself may reject ('microphone'
    // is not a valid PermissionName on every engine), so the whole probe is
    // fall-through, never a throw.
    try {
        const state = (await navigator.permissions?.query({ name: 'microphone' } as PermissionDescriptor))?.state;
        if (state === 'denied') {
            return 'Microphone access was denied before for this site — re-enable it in the browser site settings (the mic icon / padlock menu next to the address bar), then try again.';
        }
    } catch {
        // Permissions API missing or 'microphone' unsupported: fall through to
        // the generic diagnosis below (the original banner text is kept so the
        // user is not left with NOTHING).
    }
    // Remaining causes (iframe permission policy, OS/other-app lock, managed
    // policy): unprovable from the page, so name the suspects honestly.
    return 'Microphone access was denied without a prompt — the browser site settings may be blocking it, or this embedded page is missing microphone permission. Check the mic icon in the address bar.';
};

// Append a recognized transcript onto the existing composer draft: empty
// draft → the transcript alone; non-empty draft → ONE separating space,
// skipped when the draft already ends in whitespace (never a double space,
// never a glued word). Pure so the append rule stays unit-testable and the
// composer can reuse it verbatim for interim AND final frames.
export const appendTranscript = (draft: string, transcript: string): string => {
    if (transcript === '') return draft;
    if (draft === '') return transcript;
    return /\s$/.test(draft) ? draft + transcript : `${draft} ${transcript}`;
};

// Options for a single recognition session.
export interface SpeechRecognizerOptions {
    // BCP-47 speech language; defaults to navigator.language at start.
    language?: string;
    onTranscript: (transcript: string, final: boolean) => void;
    onError: (detail: string) => void;
    onEnd: () => void;
}

// One session handle: start() is single-flight (false while active or when
// the API is missing at start time), stop() asks the ENGINE to end (its
// onend route settles the session), dispose() detaches every engine callback
// and settles SILENTLY (unmount path: the caller no longer exists to notify).
export interface SpeechRecognizerHandle {
    start(): boolean;
    stop(): void;
    dispose(): void;
}

// Create a session handle bound to the given callbacks. The engine instance
// is constructed per start() call (never reused across sessions): the
// recognition object holds per-instance engine state, and fresh instances
// between composer taps avoid stale state between sessions.
export const createSpeechRecognizer = (options: SpeechRecognizerOptions): SpeechRecognizerHandle => {
    let instance: ISpeechRecognition | null = null;
    let sessionActive = false;
    // Monotonic session settlement: the FIRST terminal path (final result /
    // engine onend / error / dispose) wins; every later engine callback is
    // a no-op. Engine terminal events arrive MULTIPLE TIMES in practice
    // (onerror followed by onend; explicit stop() followed by onend).
    let settled = false;
    let disposed = false;

    // Single-fire, dispose-guarded session end delivery.
    const settle = (): void => {
        if (settled || disposed) return;
        settled = true;
        options.onEnd();
    };

    return {
        start: () => {
            if (disposed || sessionActive) return false;
            // Re-resolve at start (NOT only at handle creation): the browser
            // may load the API lazily, and jsdom tests stub the global later.
            const constructor = resolveRecognitionConstructor();
            if (!constructor) return false;
            instance = new constructor();
            // One utterance per composer session; interim frames stream in
            // while the user speaks, the final frame settles it.
            instance.lang = options.language ?? (typeof navigator !== 'undefined' && navigator.language ? navigator.language : '');
            instance.continuous = false;
            instance.interimResults = true;
            instance.maxAlternatives = 1;
            instance.onresult = (event) => {
                // event.results carries the CURRENT COMPLETE state of every
                // group recognized so far (updated in place when an interim
                // group supersedes — the same index, new text). Recomputing
                // the cumulative sum from 0 on every event is therefore both
                // complete (multi-group sessions keep their prefix) and safe:
                // each event REPLACES the previous display, it never stacks
                // on it.
                if (settled) return;
                let text = '';
                let final = false;
                for (let i = 0; i < event.results.length; i += 1) {
                    const result = event.results[i];
                    text += result[0]?.transcript ?? '';
                    final = final || result.isFinal;
                }
                if (text !== '') options.onTranscript(text, final);
                if (final) {
                    // Final frame: settle the session immediately (onEnd),
                    // then stop the engine so no further frames arrive; the
                    // engine's onend route hits settle() as a no-op.
                    settle();
                    instance?.stop();
                }
            };
            instance.onerror = (event) => {
                // Late error frames after settlement (engines dispatch
                // onerror AND onend) must not re-deliver the label.
                if (settled) return;
                sessionActive = false;
                const detail = speechErrorLabel(event.error);
                if (detail !== '') options.onError(detail);
                settle();
            };
            instance.onend = () => {
                sessionActive = false;
                settle();
            };
            instance.start();
            sessionActive = true;
            return true;
        },
        stop: () => {
            // UI stop (the composer's mic→X toggle): the engine fires onend,
            // whose settle() delivers the single onEnd to the listener.
            if (!sessionActive || instance === null) return;
            sessionActive = false;
            instance.stop();
        },
        dispose: () => {
            // Unmount path: detach BEFORE stopping so the engine's terminal
            // events can never reach callbacks whose owner is gone, and
            // suppress settlement (a disposed caller must hear nothing).
            // Idempotent by the disposed flag.
            if (disposed) return;
            disposed = true;
            if (instance !== null) {
                instance.onresult = null;
                instance.onerror = null;
                instance.onend = null;
                try {
                    instance.stop();
                } catch {
                    // Engines may reject stop() before start() was served; the
                    // session is being abandoned, so the throw is swallowed.
                }
            }
            instance = null;
            sessionActive = false;
        }
    };
};