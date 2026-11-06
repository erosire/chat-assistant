// VOICE plugin tests: the session lifecycle, without a Web Speech API anywhere.
//
// The injected `SpeechClient` double is the point: `createVoicePlugin({ speech })`
// takes the same facade the plugin publishes as `chat.speech`, so a test drives the
// engine's callbacks directly (interim / final / error / stop) and never stubs a
// browser global — which is also the acceptance rule that voice must not crash where
// the API is absent (jsdom, Firefox).
//
// The behavior under test is the oracle's toggle, ported from
// components/ChatAssistantApp.tsx:4174-4270. Each case pins one rule of it:
//   - a pre-check failure surfaces ACTIONABLE text and leaves the mic off;
//   - frames append onto the SNAPSHOT taken at session start (pre-typed words
//     survive) and CUMULATIVE frames replace each other (nothing doubles up);
//   - a finished utterance submits itself ONCE, and only after a frame arrived;
//   - an explicit stop keeps the partial text and never auto-sends;
//   - a silent 'not-allowed' is re-diagnosed instead of shown as a generic label;
//   - a mode switch mid-utterance drops the auto-send (R7) but keeps the text.
import { dashboard } from '@underload/dashboard';
import type { Dashboard, DashboardPlugin } from '@underload/dashboard';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    CHAT_DRAFT_STATE,
    CHAT_ERROR_STATE,
    CHAT_LISTENING_STATE,
    CHAT_MESSAGE_SEND_COMMAND,
    CHAT_MODE_STATE,
    CHAT_MODEL_STATE,
    CHAT_SESSIONS_STATE,
    CHAT_SPEECH_SERVICE,
    CHAT_STREAM_STARTED_EVENT,
    CHAT_VOICE_START_COMMAND,
    CHAT_VOICE_STOP_COMMAND,
    type ChatMode,
    type ChatSession,
    type StreamStartedEvent
} from '../contract';
import type { SpeechClient, SpeechClientHandlers, SpeechHandle } from '../services/speech';
import { createChatPlugins } from './chat';
import { createCorePlugin } from './core';
import { createVoicePlugin, MICROPHONE_DENIED_LABEL } from './voice';
import {
    jsonResponse,
    installFetch,
    recordFixture,
    resetStorage,
    sseDelta,
    sseResponse,
    SSE_DONE,
    TEST_BASE_URL,
    TEST_PROVIDER_URL,
    type FetchDouble
} from './harness';

// ——— the exact api/speech.ts diagnostics the client rejects or resolves with ——————

const UNSUPPORTED_MESSAGE =
    'Voice input is not available: this browser does not expose the Web Speech recognition API (Chrome and Edge do; Firefox and embedded webviews generally do not).';
const INSECURE_MESSAGE =
    'Microphone access is blocked: this page is not on HTTPS or localhost, so the browser denies the microphone silently without asking. Serve the page over HTTPS (or open it from localhost) to use voice input.';
const STICKY_DENIED_MESSAGE =
    'Microphone access was denied before for this site — re-enable it in the browser site settings (the mic icon / padlock menu next to the address bar), then try again.';

// ——— the engine double —————————————————————————————————————————————————————————

type FakeSession = {
    handlers: SpeechClientHandlers;
    handle: SpeechHandle;
    stopCalls: number;
};

/**
 * A controllable client: every started session keeps its handler triple, so a test
 * delivers frames in whatever order it chooses. `refuseWith` reproduces the client's
 * pre-check rejection (services/speech.ts:77-84) without touching a global.
 */
function createFakeSpeech(refuseWith?: string): { client: SpeechClient; sessions: FakeSession[] } {
    const sessions: FakeSession[] = [];
    const client: SpeechClient = {
        available: async () => refuseWith === undefined,
        start: async (handlers: SpeechClientHandlers): Promise<SpeechHandle> => {
            if (refuseWith !== undefined) throw new Error(refuseWith);
            const session: FakeSession = {
                handlers,
                handle: undefined as unknown as SpeechHandle,
                stopCalls: 0
            };
            const handle: SpeechHandle = {
                stop: (): void => {
                    session.stopCalls += 1;
                    // The real handle's stop() also disposes the engine callbacks, so a
                    // stopped session delivers nothing further afterwards
                    // (services/speech.ts:116-125).
                    Object.defineProperty(handle, 'active', { configurable: true, value: false });
                },
                get active(): boolean {
                    return true;
                }
            };
            session.handle = handle;
            sessions.push(session);
            return handle;
        }
    };
    return { client, sessions };
}

/** The `chat.message.send` owner: the plugin dispatches the auto-send through it. */
function sendProbe(calls: unknown[]): DashboardPlugin {
    return {
        id: 'test.send-probe',
        setup(api) {
            api.command<unknown, Promise<void>>(CHAT_MESSAGE_SEND_COMMAND, (input) => {
                calls.push(input);
                return Promise.resolve();
            });
        }
    };
}

let instance: Dashboard | null = null;
let sends: unknown[] = [];

const compose = (speech: SpeechClient): Dashboard => {
    sends = [];
    instance = dashboard({
        plugins: [createCorePlugin(), createVoicePlugin({ speech }), sendProbe(sends)]
    });
    return instance;
};

/** Run one voice command and await the promise the start handler returns. */
const voice = async (command: string): Promise<void> => {
    await instance?.execute<void, Promise<void>>(command);
};

/** Read one of the three cells every case asserts about. */
const cell = <T>(chat: Dashboard, id: string): T => chat.state<T>(id).get();

beforeEach(() => {
    resetStorage();
});

afterEach(() => {
    instance?.dispose();
    instance = null;
    sends = [];
});

describe('the chat.speech service', () => {
    it('publishes exactly the client the plugin was built with', async () => {
        const fake = createFakeSpeech();
        const chat = compose(fake.client);
        // The composer controls resolve this id; the identity check is the proof that
        // the plugin did not construct a second client of its own.
        expect(chat.service<SpeechClient>(CHAT_SPEECH_SERVICE)).toBe(fake.client);
        expect(await fake.client.available()).toBe(true);
    });
});

describe('the pre-check failure paths', () => {
    it('reports an API-less browser and never raises the mic', async () => {
        const fake = createFakeSpeech(UNSUPPORTED_MESSAGE);
        const chat = compose(fake.client);
        chat.state<string>(CHAT_DRAFT_STATE).set('typed before');

        await voice(CHAT_VOICE_START_COMMAND);

        expect(cell<string>(chat, CHAT_ERROR_STATE)).toBe(UNSUPPORTED_MESSAGE);
        expect(cell<boolean>(chat, CHAT_LISTENING_STATE)).toBe(false);
        expect(cell<string>(chat, CHAT_DRAFT_STATE)).toBe('typed before');
        expect(fake.sessions).toHaveLength(0);
        expect(sends).toEqual([]);
    });

    it('reports the insecure-context diagnosis when the origin check refuses', async () => {
        // The oracle probes supported() BEFORE the secure-context check for the same
        // reason: an origin that is both must report the true cause (:4184-4205), and
        // the client keeps that order (services/speech.ts:78-84).
        const fake = createFakeSpeech(INSECURE_MESSAGE);
        const chat = compose(fake.client);

        await voice(CHAT_VOICE_START_COMMAND);

        expect(cell<string>(chat, CHAT_ERROR_STATE)).toBe(INSECURE_MESSAGE);
        expect(cell<boolean>(chat, CHAT_LISTENING_STATE)).toBe(false);
        expect(sends).toEqual([]);
    });

    it('treats a second start as the oracle\'s explicit stop instead of a second session', async () => {
        const fake = createFakeSpeech();
        const chat = compose(fake.client);

        await voice(CHAT_VOICE_START_COMMAND);
        fake.sessions[0].handlers.onInterim('half a sentence');
        await voice(CHAT_VOICE_START_COMMAND);

        // The oracle's ONE handler toggles: a tap while listening disposes the session
        // silently, keeps what it heard in the composer, and never auto-sends
        // (:4175-4182). VoiceButton normally routes that tap to `chat.voice.stop`; this
        // guard is what makes a direct `chat.voice.start` mean the same thing instead of
        // opening a second live engine on one surface.
        expect(fake.sessions).toHaveLength(1);
        expect(fake.sessions[0].stopCalls).toBe(1);
        expect(cell<boolean>(chat, CHAT_LISTENING_STATE)).toBe(false);
        expect(cell<string>(chat, CHAT_DRAFT_STATE)).toBe('half a sentence');
        expect(sends).toEqual([]);
    });

    it('clears the previous failure the moment a session opens', async () => {
        const fake = createFakeSpeech();
        const chat = compose(fake.client);
        chat.state<string>(CHAT_ERROR_STATE).set('a stale failure');

        await voice(CHAT_VOICE_START_COMMAND);

        // The oracle clears the banner when the mic goes on (:4214), so a new attempt
        // is never shown next to the old attempt's reason.
        expect(cell<string>(chat, CHAT_ERROR_STATE)).toBe('');
        expect(fake.sessions).toHaveLength(1);
    });
});

describe('transcript accumulation', () => {
    it('rewrites the draft from the session snapshot so cumulative frames never stack', async () => {
        const fake = createFakeSpeech();
        const chat = compose(fake.client);
        chat.state<string>(CHAT_DRAFT_STATE).set('pre-typed');
        expect(cell<boolean>(chat, CHAT_LISTENING_STATE)).toBe(false);

        await voice(CHAT_VOICE_START_COMMAND);
        expect(cell<boolean>(chat, CHAT_LISTENING_STATE)).toBe(true);

        const live = fake.sessions[0].handlers;
        live.onInterim('hello');
        expect(cell<string>(chat, CHAT_DRAFT_STATE)).toBe('pre-typed hello');

        // The next interim REPLACES the previous one: api/speech.ts delivers the
        // cumulative state of the utterance, so 'hello there' must not double the 'hello'.
        live.onInterim('hello there');
        expect(cell<string>(chat, CHAT_DRAFT_STATE)).toBe('pre-typed hello there');

        live.onFinal('hello there friend');
        expect(cell<string>(chat, CHAT_DRAFT_STATE)).toBe('pre-typed hello there friend');
    });

    it('keeps appending onto the snapshot even if the operator types mid-session', async () => {
        // The snapshot is the append base for the whole session (the oracle's
        // `speechDraft` ref, :4206-4212), which keeps the recognized text aligned
        // instead of stacking onto whatever landed in between.
        const fake = createFakeSpeech();
        const chat = compose(fake.client);
        chat.state<string>(CHAT_DRAFT_STATE).set('base');

        await voice(CHAT_VOICE_START_COMMAND);
        chat.state<string>(CHAT_DRAFT_STATE).set('typed during the session');
        fake.sessions[0].handlers.onInterim('spoken');

        expect(cell<string>(chat, CHAT_DRAFT_STATE)).toBe('base spoken');
    });

    it('adds no separator to a blank draft', async () => {
        const fake = createFakeSpeech();
        const chat = compose(fake.client);

        await voice(CHAT_VOICE_START_COMMAND);
        fake.sessions[0].handlers.onInterim('just speech');

        // `appendTranscript` (api/speech.ts:171-175) owns the one-space rule: an empty
        // draft takes the transcript verbatim, with no leading space.
        expect(cell<string>(chat, CHAT_DRAFT_STATE)).toBe('just speech');
    });
});

describe('the finished-utterance auto-send', () => {
    it('sends exactly once, with no input, and takes the mic chrome off', async () => {
        const fake = createFakeSpeech();
        const chat = compose(fake.client);
        chat.state<string>(CHAT_DRAFT_STATE).set('ask this');

        await voice(CHAT_VOICE_START_COMMAND);
        const live = fake.sessions[0].handlers;
        live.onInterim('ask this now');
        expect(sends).toEqual([]);
        live.onFinal('ask this now');

        // The settled utterance goes through the SAME send command a typed message
        // uses, with the void input the contract documents (:4260).
        expect(sends).toEqual([undefined]);
        expect(cell<boolean>(chat, CHAT_LISTENING_STATE)).toBe(false);
    });

    it('never sends a session that ended without hearing anything', async () => {
        const fake = createFakeSpeech();
        const chat = compose(fake.client);
        chat.state<string>(CHAT_DRAFT_STATE).set('stale pre-typed draft');

        await voice(CHAT_VOICE_START_COMMAND);
        expect(cell<boolean>(chat, CHAT_LISTENING_STATE)).toBe(true);
        await voice(CHAT_VOICE_STOP_COMMAND);

        // The oracle's `voiceTranscript` gate: a session that produced no frame leaves
        // the pre-session text alone and submits nothing (:4257-4260).
        expect(sends).toEqual([]);
        expect(cell<string>(chat, CHAT_DRAFT_STATE)).toBe('stale pre-typed draft');
        expect(cell<boolean>(chat, CHAT_LISTENING_STATE)).toBe(false);
    });

    it('drops the auto-send when the mode changed under the session', async () => {
        // R7: the utterance belongs to the namespace that started it. The text stays in
        // the composer (the core preserves the draft across a switch, core.ts:528-531)
        // but nothing is submitted into a mode the operator has already left.
        const fake = createFakeSpeech();
        const chat = compose(fake.client);

        await voice(CHAT_VOICE_START_COMMAND);
        chat.state<ChatMode>(CHAT_MODE_STATE).set('offline');
        fake.sessions[0].handlers.onFinal('spoken after the switch');

        expect(sends).toEqual([]);
        expect(cell<string>(chat, CHAT_DRAFT_STATE)).toBe('spoken after the switch');
        expect(cell<boolean>(chat, CHAT_LISTENING_STATE)).toBe(false);
    });
});

describe('explicit stop', () => {
    it('keeps the partial transcript for review and stops the engine once', async () => {
        const fake = createFakeSpeech();
        const chat = compose(fake.client);
        chat.state<string>(CHAT_DRAFT_STATE).set('note then');

        await voice(CHAT_VOICE_START_COMMAND);
        fake.sessions[0].handlers.onInterim('spoken part');
        const stopped = chat.execute<void, boolean>(CHAT_VOICE_STOP_COMMAND);

        expect(stopped).toBe(true);
        expect(fake.sessions[0].stopCalls).toBe(1);
        expect(cell<string>(chat, CHAT_DRAFT_STATE)).toBe('note then spoken part');
        expect(cell<boolean>(chat, CHAT_LISTENING_STATE)).toBe(false);
        // An explicit stop is an abort, never an auto-send (:4175-4182).
        expect(sends).toEqual([]);
    });

    it('reports false and touches nothing when no session is live', () => {
        const fake = createFakeSpeech();
        const chat = compose(fake.client);

        expect(chat.execute<void, boolean>(CHAT_VOICE_STOP_COMMAND)).toBe(false);
        expect(fake.sessions).toHaveLength(0);
        expect(cell<boolean>(chat, CHAT_LISTENING_STATE)).toBe(false);
    });
});

describe('engine failures', () => {
    it('surfaces a plain engine label and closes the session', async () => {
        const fake = createFakeSpeech();
        const chat = compose(fake.client);

        await voice(CHAT_VOICE_START_COMMAND);
        fake.sessions[0].handlers.onError('No microphone was found.');

        expect(cell<string>(chat, CHAT_ERROR_STATE)).toBe('No microphone was found.');
        expect(cell<boolean>(chat, CHAT_LISTENING_STATE)).toBe(false);
        expect(sends).toEqual([]);
    });

    it('re-diagnoses a silent denial instead of showing the generic label', async () => {
        // The insecure-context probe is the FIRST cause api/speech.ts checks
        // (src/api/speech.ts:145-147), so a false `isSecureContext` is the
        // deterministic way to pin the swap the oracle performs at :4241-4244.
        const descriptor = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
        Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
        try {
            const fake = createFakeSpeech();
            const chat = compose(fake.client);

            await voice(CHAT_VOICE_START_COMMAND);
            fake.sessions[0].handlers.onError(MICROPHONE_DENIED_LABEL);

            // The generic label never reaches the banner: the diagnosis is a promise,
            // so the banner is still clean in the same tick...
            expect(cell<string>(chat, CHAT_ERROR_STATE)).toBe('');
            // ...and resolves to the actionable HTTPS/localhost message.
            await Promise.resolve();
            await Promise.resolve();
            expect(cell<string>(chat, CHAT_ERROR_STATE)).toBe(INSECURE_MESSAGE);
        } finally {
            if (descriptor) Object.defineProperty(window, 'isSecureContext', descriptor);
            else delete (window as unknown as { isSecureContext?: boolean }).isSecureContext;
        }
    });

    it('names the sticky site denial when the origin is secure', async () => {
        const secure = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
        const permissions = Object.getOwnPropertyDescriptor(navigator, 'permissions');
        Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
        Object.defineProperty(navigator, 'permissions', {
            configurable: true,
            value: { query: async () => ({ state: 'denied' }) }
        });
        try {
            const fake = createFakeSpeech();
            const chat = compose(fake.client);

            await voice(CHAT_VOICE_START_COMMAND);
            fake.sessions[0].handlers.onError(MICROPHONE_DENIED_LABEL);
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            expect(cell<string>(chat, CHAT_ERROR_STATE)).toBe(STICKY_DENIED_MESSAGE);
        } finally {
            if (secure) Object.defineProperty(window, 'isSecureContext', secure);
            if (permissions) Object.defineProperty(navigator, 'permissions', permissions);
            else delete (navigator as unknown as { permissions?: unknown }).permissions;
        }
    });
});

describe('teardown', () => {
    it('stops a live session on dispose and survives a late frame afterwards', async () => {
        const fake = createFakeSpeech();
        const chat = compose(fake.client);

        await voice(CHAT_VOICE_START_COMMAND);
        const live = fake.sessions[0];
        chat.dispose();
        instance = null;

        expect(live.stopCalls).toBe(1);
        // A frame that arrives after the surface is gone must not write a DETACHED cell
        // (a disposed cell's `set` throws) and must not dispatch a send against a
        // command registry that no longer exists, so the late session is silent.
        expect(() => live.handlers.onInterim('too late')).not.toThrow();
        expect(() => live.handlers.onFinal('too late')).not.toThrow();
        expect(sends).toEqual([]);
    });
});

// ——— S1: a send owns the composer ——————————————————————————————————————————————
// The oracle ends the voice session at the HEAD of `submit()` (:3874-3879) so the
// transcript already in the input is exactly what gets sent AND the engine stops
// rewriting the draft during the provider round-trip. The rebuild does that twice
// over, and both halves are pinned here:
//   - `plugins/source.ts` runs `chat.voice.stop` before it reads the draft (the
//     only seam early enough for the ONLINE new-chat path, whose
//     `chat.stream.started` event lands AFTER the pending-record POST);
//   - `plugins/voice.ts` halts itself on `chat.stream.started`, which is the seam
//     for every OTHER producer of a stream.
// The regression each case pins is stated in its own assertion comment.
describe('a send halts the live recognizer', () => {
    it('stops the engine when chat.stream.started lands and silences every later frame', async () => {
        const fake = createFakeSpeech();
        const chat = compose(fake.client);

        await voice(CHAT_VOICE_START_COMMAND);
        const live = fake.sessions[0].handlers;
        live.onInterim('spoken part');
        expect(cell<string>(chat, CHAT_DRAFT_STATE)).toBe('spoken part');
        expect(cell<boolean>(chat, CHAT_LISTENING_STATE)).toBe(true);
        expect(fake.sessions[0].stopCalls).toBe(0);

        // The contract event every producer of a stream emits
        // (plugins/source.ts emits it at :550).
        chat.emit<StreamStartedEvent>(CHAT_STREAM_STARTED_EVENT, {
            sessionId: 'conv-1',
            requestId: 'request-1'
        });

        // The halt is a full teardown: the engine is stopped and the mic chrome drops.
        expect(fake.sessions[0].stopCalls).toBe(1);
        expect(cell<boolean>(chat, CHAT_LISTENING_STATE)).toBe(false);

        // THE REGRESSION: a real `SpeechRecognition` can still have result events
        // queued after dispose(), and a continuous engine keeps speaking. Neither a
        // late INTERIM nor a late FINAL frame may touch the composer now (the send has
        // already cleared it for the assistant's turn), and a late FINAL frame may not
        // dispatch a SECOND send.
        live.onInterim('rewritten while the reply streams');
        live.onFinal('rewritten while the reply streams');
        expect(cell<string>(chat, CHAT_DRAFT_STATE)).toBe('spoken part');
        expect(sends).toEqual([]);
        expect(fake.sessions[0].stopCalls).toBe(1);
    });

    it('does not let one utterance send twice', async () => {
        const fake = createFakeSpeech();
        const chat = compose(fake.client);

        await voice(CHAT_VOICE_START_COMMAND);
        const live = fake.sessions[0].handlers;
        live.onInterim('ask this now');
        live.onFinal('ask this now');
        expect(sends).toEqual([undefined]);
        // The auto-send releases the session it is handing off (the oracle's
        // `submit()` head runs inside the very flow the auto-send dispatches), so the
        // engine is already stopped at the moment of the send.
        expect(fake.sessions[0].stopCalls).toBe(1);

        // A second FINAL frame from the SAME session is inert: one send, one draft
        // write, one stop(). Without the per-session generation gate this is the
        // double-send the oracle cannot produce.
        live.onFinal('ask this now again');
        live.onInterim('and again');
        expect(sends).toEqual([undefined]);
        expect(cell<string>(chat, CHAT_DRAFT_STATE)).toBe('ask this now');
        expect(fake.sessions[0].stopCalls).toBe(1);
        expect(cell<boolean>(chat, CHAT_LISTENING_STATE)).toBe(false);
    });

    describe('against the real send pipeline', () => {
        let double: FetchDouble | null = null;

        /**
         * The online new-chat backend, in the shape `services/conversations.ts`
         * expects (POST -> track -> canonical GET, then the append POST and its
         * read-back). `pollIntervalMs` stays large in the composition so the R14
         * poller never interleaves a second list request into the assertions.
         */
        const newChatRoutes = () => {
            const created = recordFixture('conv-1', {
                title: 'New conversation',
                messages: [],
                model: 'alpha/flash',
                status: 'pending'
            });
            const settled = recordFixture('conv-1', {
                title: 'hello world',
                model: 'alpha/flash',
                status: 'complete',
                messages: [
                    { role: 'user', content: 'hello world' },
                    { role: 'assistant', content: 'Reply', model: 'alpha/flash' }
                ]
            });
            let reads = 0;
            return [
                {
                    match: (url: string) => url === `${TEST_PROVIDER_URL}/models`,
                    reply: () => jsonResponse(200, { object: 'list', data: [{ id: 'alpha/flash' }] })
                },
                {
                    match: (url: string) => url === `${TEST_PROVIDER_URL}/chat/completions`,
                    reply: () => sseResponse([sseDelta('Reply'), SSE_DONE])
                },
                {
                    match: (url: string) => url === TEST_BASE_URL,
                    reply: () => jsonResponse(201, { conversationId: 'conv-1' })
                },
                {
                    match: (url: string) => url === `${TEST_BASE_URL}/conv-1`,
                    reply: (_url: string, init?: RequestInit) =>
                        (init?.method ?? 'GET') === 'POST'
                            ? jsonResponse(201, { conversationId: 'conv-1' })
                            : jsonResponse(200, {
                                conversationId: 'conv-1',
                                conversation: reads++ === 0 ? created : settled
                            })
                },
                {
                    match: (url: string) => url.startsWith(TEST_BASE_URL),
                    reply: () => jsonResponse(200, { conversations: [] })
                }
            ];
        };

        afterEach(() => {
            double = null;
            vi.unstubAllGlobals();
        });

        /** The same graph `createTestChat` builds, with an injectable speech client. */
        const composeWithSource = (speech: SpeechClient): Dashboard =>
            dashboard({
                plugins: [
                    ...createChatPlugins({
                        baseUrl: TEST_BASE_URL,
                        providerUrl: TEST_PROVIDER_URL,
                        pollIntervalMs: 5_000
                    }),
                    createVoicePlugin({ speech })
                ]
            });

        it('halts the engine BEFORE the pending-record POST, so no frame rewrites the cleared draft', async () => {
            double = installFetch(newChatRoutes());
            const fake = createFakeSpeech();
            const chat = composeWithSource(fake.client);
            instance = chat;

            // A model has to exist for `send()` to accept the draft at all (the
            // catalog effect adopts the first sorted entry).
            await vi.waitFor(() => {
                expect(chat.state<string>(CHAT_MODEL_STATE).get()).toBe('alpha/flash');
            });
            chat.state<string>(CHAT_DRAFT_STATE).set('');
            await voice(CHAT_VOICE_START_COMMAND);
            const live = fake.sessions[0].handlers;
            live.onInterim('hello world');
            expect(cell<string>(chat, CHAT_DRAFT_STATE)).toBe('hello world');

            // Fire the send and DON'T await it: the online new-chat path is now sitting
            // inside the pending-record POST, which is exactly the window in which
            // `chat.stream.started` has not been emitted yet. The oracle's `submit()`
            // head has already disposed the recognizer here; the head-of-send halt in
            // plugins/source.ts is the port of that ordering.
            const sending = chat.execute<void, Promise<void>>(CHAT_MESSAGE_SEND_COMMAND);
            live.onInterim('a frame that lands during the POST');
            expect(cell<string>(chat, CHAT_DRAFT_STATE)).toBe('');
            expect(fake.sessions[0].stopCalls).toBe(1);

            await sending;

            // One provider request, carrying the transcript the engine wrote before the
            // halt — not the frame that arrived after it.
            const completions = double.callsFor('/chat/completions');
            expect(completions).toHaveLength(1);
            expect((completions[0].body as { messages: unknown }).messages).toEqual([
                { role: 'user', content: 'hello world' }
            ]);
            expect(cell<boolean>(chat, CHAT_LISTENING_STATE)).toBe(false);
            expect(cell<string>(chat, CHAT_DRAFT_STATE)).toBe('');
            // The turn completed normally, so the halting did not disturb the send.
            expect(chat.state<readonly ChatSession[]>(CHAT_SESSIONS_STATE).get()).toEqual([
                expect.objectContaining({ conversationId: 'conv-1' })
            ]);
        });
    });
});
