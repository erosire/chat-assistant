// Deterministic tests for the Web Speech API wrapper (src/api/speech.ts).
// jsdom ships NO SpeechRecognition, so the feature probe is false by
// default; the session tests install a fake constructor on the global (the
// exact ISpeechRecognition structural surface the wrapper consumes) and drive
// the captured engine callbacks to assert: config pushed onto the engine,
// transcript accumulation semantics (each event recomputes the cumulative
// from the FULL results array), the exactly-once onEnd across every terminal
// path, error-label pass-through vs silent benign endings, single-flight
// start, and the silent dispose contract.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    appendTranscript,
    createSpeechRecognizer,
    speechContextSecure,
    speechDeniedDetail,
    speechErrorLabel,
    speechRecognitionSupported,
    type ISpeechRecognition
} from './speech';

// Fake engine: records the config the wrapper pushes, and lets the test fire
// the engine callbacks (onresult/onerror/onend) exactly when the test wants.
// `stop()` fires onend because a real engine settles the session that way.
type FakeEngine = {
    started: number;
    instance: ISpeechRecognition;
};
const installFakeRecognition = (name: 'SpeechRecognition' | 'webkitSpeechRecognition'): { engines: FakeEngine[] } => {
    const engines: FakeEngine[] = [];
    const FakeRecognition = vi.fn(function (this: unknown) {
        const engine: FakeEngine = {
            started: 0,
            instance: {
                lang: '',
                continuous: true,
                interimResults: false,
                maxAlternatives: 1,
                onresult: null,
                onerror: null,
                onend: null,
                start: () => {
                    engine.started += 1;
                },
                stop: () => {
                    engine.instance.onend?.();
                }
            } as unknown as ISpeechRecognition
        };
        engine.instance.start = () => {
            engine.started += 1;
        };
        engine.instance.stop = () => {
            engine.instance.onend?.();
        };
        engines.push(engine);
        return engine.instance;
    });
    vi.stubGlobal(name, FakeRecognition);
    return { engines };
};

// Collector harness for one recognizer's callbacks.
const harness = () => {
    const transcripts: Array<[string, boolean]> = [];
    const errors: string[] = [];
    let endCount = 0;
    const recognizer = createSpeechRecognizer({
        onTranscript: (transcript, final) => transcripts.push([transcript, final]),
        onError: (detail) => errors.push(detail),
        onEnd: () => {
            endCount += 1;
        }
    });
    return {
        transcripts,
        errors,
        endCount: () => endCount,
        recognizer,
    };
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('speechRecognitionSupported', () => {
    it('is false in an API-less environment (jsdom)', () => {
        expect(speechRecognitionSupported()).toBe(false);
    });
    it('is true once the standard or the webkit-prefixed constructor exists', () => {
        installFakeRecognition('SpeechRecognition');
        expect(speechRecognitionSupported()).toBe(true);
        vi.unstubAllGlobals();
        installFakeRecognition('webkitSpeechRecognition');
        expect(speechRecognitionSupported()).toBe(true);
    });
});

// --- speechDeniedDetail environment control ---------------------------------
// The diagnostic reads two live platform surfaces: window.isSecureContext and
// navigator.permissions. jsdom provides the former (data property on window)
// and NONE of the latter (navigator.permissions is undefined), so tests
// override both via defineProperty and restore the exact pre-test state after
// every test (the jsdom window is shared across the whole test file).
const ORIGINAL_SECURE_CONTEXT = window.isSecureContext;
const setSecureContext = (value: boolean): void => {
    Object.defineProperty(window, 'isSecureContext', {
        value,
        configurable: true,
        writable: true
    });
};
// Stub the Permissions API on the navigator instance (shadowing any prototype
// accessor); passing undefined deletes it again.
const setPermissions = (stub: { query: (descriptor: unknown) => Promise<{ state: string }> } | undefined): void => {
    if (stub === undefined) {
        delete (navigator as unknown as { permissions?: unknown }).permissions;
        return;
    }
    Object.defineProperty(navigator, 'permissions', { value: stub, configurable: true, writable: true });
};

describe('speechContextSecure', () => {
    afterEach(() => {
        setSecureContext(ORIGINAL_SECURE_CONTEXT);
    });

    it('is false exactly when window.isSecureContext is strictly false (the insecure-HTTP-LAN case)', () => {
        setSecureContext(false);
        expect(speechContextSecure()).toBe(false);
    });

    it('is true in a genuine secure context (https / localhost)', () => {
        setSecureContext(true);
        expect(speechContextSecure()).toBe(true);
    });

    it('treats an UNDEFINED isSecureContext as secure (older engines must not be misreported)', () => {
        // Force the property to undefined: the probe uses `!== false` precisely
        // so a missing flag (not a literal false) does not block microphone use.
        Object.defineProperty(window, 'isSecureContext', {
            value: undefined,
            configurable: true,
            writable: true
        });
        expect(speechContextSecure()).toBe(true);
    });
});

describe('speechDeniedDetail', () => {
    afterEach(() => {
        setSecureContext(ORIGINAL_SECURE_CONTEXT);
        setPermissions(undefined);
    });

    it('reports the HTTPS/localhost requirement first when the page is on an insecure context', async () => {
        setSecureContext(false);
        // Even with a sticky site denial present, the serving-origin fix wins:
        // the Permissions query must never be consulted in an insecure context.
        let queried = false;
        setPermissions({ query: async () => { queried = true; return { state: 'denied' }; } });
        expect(await speechDeniedDetail()).toBe(
            'Microphone access is blocked: this page is not on HTTPS or localhost, so the browser denies the microphone silently without asking. Serve the page over HTTPS (or open it from localhost) to use voice input.'
        );
        expect(queried).toBe(false);
    });

    it('reports the sticky site-level block when the Permissions API says denied', async () => {
        setSecureContext(true);
        setPermissions({ query: async () => ({ state: 'denied' }) });
        expect(await speechDeniedDetail()).toBe(
            'Microphone access was denied before for this site — re-enable it in the browser site settings (the mic icon / padlock menu next to the address bar), then try again.'
        );
    });

    it('falls back to the generic diagnosis when no Permissions API exists (jsdom default)', async () => {
        setSecureContext(true);
        // jsdom ships no navigator.permissions: the probe is a no-op fall-through.
        expect(await speechDeniedDetail()).toBe(
            'Microphone access was denied without a prompt — the browser site settings may be blocking it, or this embedded page is missing microphone permission. Check the mic icon in the address bar.'
        );
    });

    it('falls back to the generic diagnosis when the microphone permission query rejects', async () => {
        setSecureContext(true);
        // Older engines reject 'microphone' as a PermissionName: the probe must
        // swallow the rejection, never throw.
        setPermissions({
            query: () => {
                throw new Error('NotAllowedError: permissions.query rejected');
            }
        } as unknown as { query: (descriptor: unknown) => Promise<{ state: string }> });
        expect(await speechDeniedDetail()).toBe(
            'Microphone access was denied without a prompt — the browser site settings may be blocking it, or this embedded page is missing microphone permission. Check the mic icon in the address bar.'
        );
    });

    it('falls back to the generic diagnosis for non-denied permission states', async () => {
        setSecureContext(true);
        // 'prompt' / 'granted' mean the mic would normally be askable: the
        // silent denial then points at iframe permission policy / OS locks —
        // the generic diagnosis names those suspects.
        setPermissions({ query: async () => ({ state: 'prompt' }) });
        expect(await speechDeniedDetail()).toBe(
            'Microphone access was denied without a prompt — the browser site settings may be blocking it, or this embedded page is missing microphone permission. Check the mic icon in the address bar.'
        );
    });
});

describe('speechErrorLabel', () => {
    it('maps every engine error code to its exact display label', () => {
        expect(speechErrorLabel('not-allowed')).toBe('Microphone access was denied.');
        expect(speechErrorLabel('service-not-allowed')).toBe('Microphone access was denied.');
        expect(speechErrorLabel('audio-capture')).toBe('No microphone was found.');
        expect(speechErrorLabel('network')).toBe('Voice input failed: network problem.');
        // Benign session endings are NOT user errors: the empty label tells
        // the caller to settle silently.
        expect(speechErrorLabel('no-speech')).toBe('');
        expect(speechErrorLabel('aborted')).toBe('');
        // Unknown codes preserve the raw code for diagnostics.
        expect(speechErrorLabel('bad-grant')).toBe('Voice input failed: bad-grant.');
    });
});

describe('appendTranscript', () => {
    it('appends with the exact separator rules', () => {
        // No draft: the transcript alone.
        expect(appendTranscript('', 'Hello world')).toBe('Hello world');
        // Draft without trailing whitespace: exactly ONE separating space.
        expect(appendTranscript('Draft text', 'Hello world')).toBe('Draft text Hello world');
        // Draft already ending in whitespace: no second separator.
        expect(appendTranscript('Draft text ', 'Hello')).toBe('Draft text Hello');
        // Empty transcript: the draft comes back unchanged.
        expect(appendTranscript('Draft', '')).toBe('Draft');
        expect(appendTranscript('', '')).toBe('');
    });
});

describe('createSpeechRecognizer', () => {
    it('refuses to start when the browser has no speech API', () => {
        const { recognizer } = harness();
        expect(recognizer.start()).toBe(false);
        // And nothing ever settles from a never-started session.
        recognizer.stop();
        recognizer.dispose();
    });

    it('configures the engine for one utterance per session with interim results', () => {
        const { engines } = installFakeRecognition('SpeechRecognition');
        const { recognizer } = harness();
        expect(recognizer.start()).toBe(true);
        // Single flight: a second start while the session is live is a no-op.
        expect(recognizer.start()).toBe(false);
        const engine = engines[0].instance;
        expect(engines[0].started).toBe(1);
        expect(engine.lang).toBe(navigator.language);
        expect(engine.continuous).toBe(false);
        expect(engine.interimResults).toBe(true);
        expect(engine.maxAlternatives).toBe(1);
    });

    it('honours an explicit language override', () => {
        const { engines } = installFakeRecognition('webkitSpeechRecognition');
        const recognizer = createSpeechRecognizer({
            language: 'de-DE',
            onTranscript: () => undefined,
            onError: () => undefined,
            onEnd: () => undefined
        });
        expect(recognizer.start()).toBe(true);
        expect(engines[0].instance.lang).toBe('de-DE');
    });

    it('delivers the cumulative transcript per frame and settles exactly once on the final', () => {
        const { engines } = installFakeRecognition('SpeechRecognition');
        const { recognizer, transcripts, errors, endCount } = harness();
        expect(recognizer.start()).toBe(true);
        const engine = engines[0].instance;
        // Interim frame: the group's current partial text.
        engine.onresult?.({
            resultIndex: 0,
            results: [{ isFinal: false, 0: { transcript: 'Hello' } }]
        });
        expect(transcripts).toEqual([['Hello', false]]);
        // Final frame: the SAME group index superseded by the settled text —
        // recomputed from the full results array, settled exactly once.
        engine.onresult?.({
            resultIndex: 0,
            results: [{ isFinal: true, 0: { transcript: 'Hello world' } }]
        });
        expect(transcripts).toEqual([
            ['Hello', false],
            ['Hello world', true]
        ]);
        expect(errors).toEqual([]);
        expect(endCount()).toBe(1);
        // The engine's onend fires right after the final stop(): the settle
        // guard keeps the end count at exactly one.
    });

    it('keeps the prefix across multi-group frames (full-array recompute)', () => {
        const { engines } = installFakeRecognition('SpeechRecognition');
        const { recognizer, transcripts, endCount } = harness();
        expect(recognizer.start()).toBe(true);
        const engine = engines[0].instance;
        // Two recognized groups, both still interim.
        engine.onresult?.({
            resultIndex: 0,
            results: [
                { isFinal: false, 0: { transcript: 'Hello ' } },
                { isFinal: false, 0: { transcript: 'there' } }
            ]
        });
        expect(transcripts).toEqual([['Hello there', false]]);
        // Group 2 supersedes in place and goes final; the cumulative sum must
        // still contain group 1's text.
        engine.onresult?.({
            resultIndex: 1,
            results: [
                { isFinal: false, 0: { transcript: 'Hello ' } },
                { isFinal: true, 0: { transcript: 'there you are' } }
            ]
        });
        expect(transcripts).toEqual([
            ['Hello there', false],
            ['Hello there you are', true]
        ]);
        expect(endCount()).toBe(1);
    });

    it('reports real engine failures with the display label and settles once', () => {
        const { engines } = installFakeRecognition('SpeechRecognition');
        const { recognizer, errors, endCount } = harness();
        expect(recognizer.start()).toBe(true);
        const engine = engines[0].instance;
        engine.onerror?.({ error: 'network' });
        expect(errors).toEqual(['Voice input failed: network problem.']);
        expect(endCount()).toBe(1);
        // The engine also dispatches onend after the error: the label must
        // not fire twice and the end count must stay at one.
        engine.onend?.();
        expect(errors).toEqual(['Voice input failed: network problem.']);
        expect(endCount()).toBe(1);
    });

    it('settles silently on benign endings (no-speech) without an error', () => {
        const { engines } = installFakeRecognition('SpeechRecognition');
        const { recognizer, errors, endCount } = harness();
        expect(recognizer.start()).toBe(true);
        engines[0].instance.onerror?.({ error: 'no-speech' });
        expect(errors).toEqual([]);
        expect(endCount()).toBe(1);
    });

    it('releases the single-flight lock after settlement for the next session', () => {
        const { engines } = installFakeRecognition('SpeechRecognition');
        const { recognizer, endCount } = harness();
        expect(recognizer.start()).toBe(true);
        // Stop the engine the way the UI toggle does; the engine's onend
        // settles the session.
        recognizer.stop();
        expect(endCount()).toBe(1);
        // A brand-new engine instance backs the next session.
        expect(recognizer.start()).toBe(true);
        expect(engines).toHaveLength(2);
        expect(engines[1].started).toBe(1);
    });

    it('disposes silently: engine events after dispose reach no callback', () => {
        const { engines } = installFakeRecognition('SpeechRecognition');
        const { recognizer, transcripts, errors, endCount } = harness();
        expect(recognizer.start()).toBe(true);
        const engine = engines[0].instance;
        recognizer.dispose();
        // The engine would still fire its stored callbacks...
        engine.onresult?.({
            resultIndex: 0,
            results: [{ isFinal: false, 0: { transcript: 'Ghost' } }]
        });
        engine.onerror?.({ error: 'network' });
        // ...but dispose detached all of them before stopping the engine.
        expect(engines[0].instance.onresult).toBeNull();
        expect(engines[0].instance.onerror).toBeNull();
        expect(engines[0].instance.onend).toBeNull();
        expect(transcripts).toEqual([]);
        expect(errors).toEqual([]);
        expect(endCount()).toBe(0);
        // A disposed handle can never start again, and disposal is idempotent.
        expect(recognizer.start()).toBe(false);
        recognizer.dispose();
    });
});