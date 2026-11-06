// Deterministic tests for the voice-input SERVICE facade
// (src/dashboard/services/speech.ts). The engine session itself is owned and
// covered by src/api/speech.test.ts; these cases pin only the facade contract:
// the availability probe, the two rejection paths that keep a plugin from
// opening a doomed session (no API at all, and a non-secure context), the
// interim/final split of the cumulative transcript frames, the readable
// permission diagnostics, and the handle's liveness + teardown. jsdom ships no
// SpeechRecognition, so the fake constructor below is the same structural stub
// the api test installs (its `stop()` fires `onend`, exactly like an engine).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ISpeechRecognition, ISpeechRecognitionResult, ISpeechRecognitionResultEvent } from '../../api/speech';
import { createSpeechClient, type SpeechClientHandlers, type SpeechHandle } from './speech';

// Exact diagnostics produced by api/speech.ts, spelled out here so a wording
// change is a visible failure (plugins render these verbatim).
const UNSUPPORTED_MESSAGE =
    'Voice input is not available: this browser does not expose the Web Speech recognition API (Chrome and Edge do; Firefox and embedded webviews generally do not).';
const INSECURE_MESSAGE =
    'Microphone access is blocked: this page is not on HTTPS or localhost, so the browser denies the microphone silently without asking. Serve the page over HTTPS (or open it from localhost) to use voice input.';

type FakeEngine = { started: number; stopped: number; instance: ISpeechRecognition };

// Install a fake constructor under the standard global and hand back every
// created engine so a test can drive its captured callbacks.
const installFakeRecognition = (name: 'SpeechRecognition' | 'webkitSpeechRecognition' = 'SpeechRecognition'): FakeEngine[] => {
    const engines: FakeEngine[] = [];
    const FakeRecognition = vi.fn(function (this: unknown) {
        const engine: FakeEngine = {
            started: 0,
            stopped: 0,
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
                    engine.stopped += 1;
                    engine.instance.onend?.();
                }
            } as unknown as ISpeechRecognition
        };
        engines.push(engine);
        return engine.instance;
    });
    vi.stubGlobal(name, FakeRecognition);
    return engines;
};

// Callback collector for one started session.
const collect = (): SpeechClientHandlers & { interim: string[]; final: string[]; errors: string[] } => {
    const interim: string[] = [];
    const final: string[] = [];
    const errors: string[] = [];
    return {
        interim,
        final,
        errors,
        onInterim: (text) => interim.push(text),
        onFinal: (text) => final.push(text),
        onError: (message) => errors.push(message)
    };
};

// One recognition frame: `results` always carries the CURRENT cumulative state,
// so a transcript is always the whole utterance so far.
const frame = (transcript: string, isFinal: boolean): ISpeechRecognitionResultEvent => ({
    resultIndex: 0,
    results: [{ 0: { transcript }, isFinal } as unknown as ISpeechRecognitionResult]
});

// Capture the rejection message of a promise exactly (a plain `toThrow` string
// only substring-matches, and these strings are the plugin-facing contract).
const rejectionMessage = async (promise: Promise<unknown>): Promise<string> => {
    try {
        await promise;
    } catch (reason) {
        return reason instanceof Error ? reason.message : String(reason);
    }
    return '';
};

// --- window.isSecureContext control (the api speech test's pattern) ---------
// The insecure-context pre-check reads a live platform surface; jsdom reports a
// secure context, so the flag is overridden for one case and then restored.
const ORIGINAL_SECURE_CONTEXT = window.isSecureContext;
const setSecureContext = (value: boolean): void => {
    Object.defineProperty(window, 'isSecureContext', { value, configurable: true, writable: true });
};
const restoreSecureContext = (): void => {
    Object.defineProperty(window, 'isSecureContext', {
        value: ORIGINAL_SECURE_CONTEXT,
        configurable: true,
        writable: true
    });
};

afterEach(() => {
    vi.unstubAllGlobals();
    restoreSecureContext();
});

describe('speech client — availability', () => {
    it('reports the API-less environment (jsdom) as unavailable', async () => {
        expect(await createSpeechClient().available()).toBe(false);
    });

    it('reports availability once the standard or the webkit-prefixed constructor exists', async () => {
        installFakeRecognition('SpeechRecognition');
        expect(await createSpeechClient().available()).toBe(true);
        vi.unstubAllGlobals();
        installFakeRecognition('webkitSpeechRecognition');
        expect(await createSpeechClient().available()).toBe(true);
    });

    it('rejects start with the unsupported diagnostic and never calls onError', async () => {
        const client = createSpeechClient();
        const handlers = collect();

        expect(await rejectionMessage(client.start(handlers))).toBe(UNSUPPORTED_MESSAGE);
        expect(handlers.errors).toEqual([]);
    });

    it('rejects start in a non-secure context with the actionable HTTPS diagnosis', async () => {
        // The engine WOULD start here (the constructor exists) and then hear
        // nothing, so the facade refuses instead of opening a doomed session.
        installFakeRecognition();
        setSecureContext(false);

        const handlers = collect();
        expect(await rejectionMessage(createSpeechClient().start(handlers))).toBe(INSECURE_MESSAGE);
        expect(handlers.errors).toEqual([]);
    });
});

describe('speech client — live session', () => {
    it('splits the cumulative frames into interim then final and ends the session', async () => {
        const engines = installFakeRecognition();
        const handlers = collect();

        const handle: SpeechHandle = await createSpeechClient().start(handlers);
        const engine = engines[0];
        expect(engine.started).toBe(1);
        expect(handle.active).toBe(true);

        engine.instance.onresult?.(frame('Hel', false));
        engine.instance.onresult?.(frame('Hello', false));
        expect(handlers.interim).toEqual(['Hel', 'Hello']);
        expect(handlers.final).toEqual([]);
        expect(handle.active).toBe(true);

        engine.instance.onresult?.(frame('Hello world', true));
        expect(handlers.final).toEqual(['Hello world']);
        expect(handlers.errors).toEqual([]);
        // A final frame settles the session and stops the engine
        // (api/speech.ts:248-254), so the handle goes inactive on its own.
        expect(handle.active).toBe(false);
        expect(engine.stopped).toBe(1);
    });

    it('stops the engine, detaches every callback, and is idempotent', async () => {
        const engines = installFakeRecognition();
        const handlers = collect();
        const handle = await createSpeechClient().start(handlers);
        const engine = engines[0];

        handle.stop();
        // Two engine stops are expected: the handle asks the engine to end and
        // then disposes it, and api/speech.ts's dispose stops the instance too
        // (its callbacks are already detached, so nothing reaches the handlers).
        expect(engine.stopped).toBe(2);
        expect(handle.active).toBe(false);
        // dispose() detached the engine callbacks, so a late frame reaches nothing.
        expect(engine.instance.onresult).toBeNull();
        expect(engine.instance.onerror).toBeNull();
        expect(engine.instance.onend).toBeNull();

        handle.stop();
        expect(engine.stopped).toBe(2);
        expect(handlers.interim).toEqual([]);
        expect(handlers.final).toEqual([]);
        expect(handlers.errors).toEqual([]);
    });

    it('surfaces a permission failure as a readable error and settles the session', async () => {
        const engines = installFakeRecognition();
        const handlers = collect();
        const handle = await createSpeechClient().start(handlers);

        engines[0].instance.onerror?.({ error: 'not-allowed' });
        expect(handlers.errors).toEqual(['Microphone access was denied.']);
        expect(handle.active).toBe(false);

        // The engine's own end event after the error must not re-open the session.
        engines[0].instance.onend?.();
        expect(handle.active).toBe(false);
        expect(handlers.errors).toEqual(['Microphone access was denied.']);
    });

    it('stays silent for a benign ending and only closes the session', async () => {
        const engines = installFakeRecognition();
        const handlers = collect();
        const handle = await createSpeechClient().start(handlers);

        engines[0].instance.onerror?.({ error: 'no-speech' });
        expect(handlers.errors).toEqual([]);
        expect(handlers.final).toEqual([]);
        expect(handle.active).toBe(false);
    });

    it('configures a fresh engine per session and never reuses one', async () => {
        const engines = installFakeRecognition();

        const first = await createSpeechClient().start(collect());
        first.stop();
        const second = await createSpeechClient().start(collect());

        expect(engines.length).toBe(2);
        expect(engines[1].started).toBe(1);
        // One utterance per composer session, with interim frames streaming in.
        expect(engines[1].instance.continuous).toBe(false);
        expect(engines[1].instance.interimResults).toBe(true);
        expect(engines[1].instance.maxAlternatives).toBe(1);
        expect(typeof engines[1].instance.lang).toBe('string');
        expect(second.active).toBe(true);
    });
});
