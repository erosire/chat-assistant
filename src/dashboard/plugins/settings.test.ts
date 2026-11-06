// SETTINGS plugin tests: the two configuration commands, in both the unit shape
// (core + settings + a cancel probe) and the REAL composition (so the mode switch is
// proven against the plugins that actually react to it).
//
// What each layer proves:
//   unit       - the command contract: validation, the equal-value no-op guard, the
//                persist/cancel ordering, and the persistence-failure path. A probe
//                `chat.message.cancel` keeps the cancel decision observable without
//                pulling the whole transport in.
//   real graph - the R7 half: a mode switch invalidates the epoch guard, wipes the old
//                namespace out of `chat.sessions` and loads the NEW namespace's rows
//                instead; a provider-base edit re-reads the catalog from the new base
//                and detaches the stream that was running against the old one.
//
// Every assertion is an EXACT value: the persisted JSON byte-for-byte, the exact cell
// values, the exact request URLs, the exact notice text.
import { dashboard } from '@underload/dashboard';
import type { Dashboard, DashboardPlugin } from '@underload/dashboard';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { upsertLocalConversation } from '../../api/offline';
import {
    CHAT_ACTIVITY_SERVICE,
    CHAT_CELLS_SERVICE,
    CHAT_EPOCH_SERVICE,
    CHAT_ERROR_STATE,
    CHAT_MODE_SET_COMMAND,
    CHAT_MODE_STATE,
    CHAT_MESSAGE_CANCEL_COMMAND,
    CHAT_MESSAGE_SEND_COMMAND,
    CHAT_NOTICE_EVENT,
    CHAT_PROVIDER_BASE_SET_COMMAND,
    CHAT_PROVIDER_BASE_STATE,
    CHAT_SESSIONS_STATE,
    type ChatActivity,
    type ChatCells,
    type ChatEpoch,
    type ChatMode,
    type ChatSession,
    type NoticeEvent
} from '../contract';
import {
    createTestChat,
    installFetch,
    jsonResponse,
    payloadsOf,
    recordEvents,
    recordFixture,
    resetStorage,
    seedModel,
    seedSettings,
    summaryFixture,
    TEST_BASE_URL,
    TEST_OFFLINE_BASE,
    type FetchDouble
} from './harness';
import { createCorePlugin } from './core';
import { createSettingsPlugin, SETTINGS_PERSIST_FAILED } from './settings';

// ——— shared fixtures ——————————————————————————————————————————————————————————

/** The notice text, asserted literally so a reword of the plugin breaks the test. */
const OFFLINE_MODE_NOTICE =
    'Offline mode: conversations are stored in this browser and the provider base URL below answers for inference.';

const CATALOG_BODY = { object: 'list', data: [{ id: 'alpha/flash' }, { id: 'zeta/turbo' }] };

/** One catalog route, answering EVERY base the tests route ('{base}/models'). */
const catalogRoute = {
    match: (url: string) => url.endsWith('/models'),
    reply: () => jsonResponse(200, CATALOG_BODY)
};

/**
 * A `chat.message.cancel` owner for the unit composition. In the real graph that
 * command belongs to `chat.source`; here the probe records only whether the settings
 * command decided to stop a stream, which is the behaviour under test.
 */
function cancelProbe(calls: unknown[]): DashboardPlugin {
    return {
        id: 'test.cancel-probe',
        setup(api) {
            api.command<unknown, boolean>(CHAT_MESSAGE_CANCEL_COMMAND, (input) => {
                calls.push(input);
                return true;
            });
            api.command<unknown, Promise<void>>(CHAT_MESSAGE_SEND_COMMAND, () => Promise.resolve());
        }
    };
}

/** A graph with no network at all: core + settings + the cancel probe. */
function composeUnit(cancelCalls: unknown[]): Dashboard {
    return dashboard({
        plugins: [createCorePlugin(), createSettingsPlugin(), cancelProbe(cancelCalls)]
    });
}

/** The persisted settings, read raw so the byte order is part of the assertion. */
const readPersisted = (): string | null =>
    window.localStorage.getItem('chat-assistant:settings');

describe('chat.mode.set — the command contract', () => {
    let instance: Dashboard | null = null;
    let cancelCalls: unknown[] = [];

    beforeEach(() => {
        resetStorage();
        cancelCalls = [];
    });

    afterEach(() => {
        instance?.dispose();
        instance = null;
        vi.restoreAllMocks();
    });

    it('persists the settings, writes the cell, and announces the consequence', () => {
        instance = composeUnit(cancelCalls);
        const events = recordEvents(instance, [CHAT_NOTICE_EVENT]);

        instance.execute<ChatMode>(CHAT_MODE_SET_COMMAND, 'offline');

        // Persisted in api/offline.ts's canonical single-base form: a blank base is the
        // empty string, never an absent key.
        expect(readPersisted()).toBe('{"mode":"offline","providerBase":""}');
        expect(instance.state<ChatMode>(CHAT_MODE_STATE).get()).toBe('offline');
        expect(payloadsOf(events, CHAT_NOTICE_EVENT)).toEqual([
            { message: OFFLINE_MODE_NOTICE } satisfies NoticeEvent
        ]);
    });

    it('is a complete no-op for the mode that is already live', () => {
        seedSettings('online', 'http://keep.test/v1');
        instance = composeUnit(cancelCalls);
        const events = recordEvents(instance, [CHAT_NOTICE_EVENT]);
        const before = readPersisted();
        const epoch = instance.service<ChatEpoch>(CHAT_EPOCH_SERVICE);
        const guard = epoch.capture();

        instance.execute<ChatMode>(CHAT_MODE_SET_COMMAND, 'online');

        // The oracle's `switchMode` returns BEFORE its epoch bump for the live mode
        // (ChatAssistantApp.tsx:3388-3389): re-picking the mode detaches nothing.
        expect(epoch.namespaceCurrent(guard)).toBe(true);
        expect(readPersisted()).toBe(before);
        expect(payloadsOf(events, CHAT_NOTICE_EVENT)).toEqual([]);
    });

    it('rejects a value outside the mode vocabulary without touching anything', () => {
        instance = composeUnit(cancelCalls);
        // Commands are reachable from untyped `instance.execute` callers, so the value
        // is validated at the seam (the same rule plugins/theme.ts:89-91 applies).
        expect(() => instance?.execute<ChatMode>(CHAT_MODE_SET_COMMAND, 'sideways')).toThrow(
            'Unknown chat mode: sideways'
        );
        expect(instance.state<ChatMode>(CHAT_MODE_STATE).get()).toBe('online');
        expect(readPersisted()).toBeNull();
    });

    it('drops the persistence warning AFTER the namespace reset, where it survives', () => {
        // A locked-down profile makes saveAssistantSettings re-throw
        // (api/offline.ts:153-160). The core's own re-persist swallows that, so this
        // command is the only place the operator can be told.
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('QuotaExceededError');
        });
        instance = composeUnit(cancelCalls);

        instance.execute<ChatMode>(CHAT_MODE_SET_COMMAND, 'offline');

        // The reset clears `chat.error` (plugins/core.ts:548), so the warning must be
        // the LAST write of the command — otherwise the banner stays blank.
        expect(instance.state<string>(CHAT_ERROR_STATE).get()).toBe(SETTINGS_PERSIST_FAILED);
        expect(instance.state<ChatMode>(CHAT_MODE_STATE).get()).toBe('offline');
    });

    it('invalidates the guard and wipes the namespace it leaves', () => {
        seedSettings('online', '');
        instance = composeUnit(cancelCalls);
        const cells = instance.service<ChatCells>(CHAT_CELLS_SERVICE);
        const activity = instance.service<ChatActivity>(CHAT_ACTIVITY_SERVICE);
        const epoch = instance.service<ChatEpoch>(CHAT_EPOCH_SERVICE);

        // A namespace mid-flight: rows, an open chat, a half-streamed reply, a failure
        // and a busy label — everything the mode being left owns.
        cells.sessions.set(Object.freeze([summaryFixture(recordFixture('stale-chat'))]));
        cells.transcript.set(Object.freeze([{ role: 'user', content: 'stale' }]));
        cells.activeSessionId.set('stale-chat');
        cells.streaming.set('half a reply');
        cells.pending.set(Object.freeze({ text: 'stale', at: 1767729600000 }));
        cells.error.set('a failure of the old mode');
        activity.begin('sending');
        expect(cells.status.get()).toBe('sending');

        const guard = epoch.capture();
        instance.execute<ChatMode>(CHAT_MODE_SET_COMMAND, 'offline');

        // R7: every flow that snapshotted the pair is obsolete, and nothing the old
        // namespace owned is still on the surface.
        expect(epoch.namespaceCurrent(guard)).toBe(false);
        expect(epoch.surfaceCurrent(guard)).toBe(false);
        expect(cells.sessions.get()).toEqual([]);
        expect(cells.transcript.get()).toEqual([]);
        expect(cells.activeSessionId.get()).toBeNull();
        expect(cells.streaming.get()).toBe('');
        expect(cells.pending.get()).toBeNull();
        expect(cells.error.get()).toBe('');
        // The busy label of the namespace being left is dropped, not inherited.
        expect(cells.status.get()).toBe('idle');
        // The mode-agnostic halves survive the switch (oracle 3385-3386).
        expect(cells.draft.get()).toBe('');
        expect(cells.model.get()).toBe('');
    });
});

describe('chat.providerBase.set — the command contract', () => {
    let instance: Dashboard | null = null;
    let cancelCalls: unknown[] = [];

    beforeEach(() => {
        resetStorage();
        cancelCalls = [];
    });

    afterEach(() => {
        instance?.dispose();
        instance = null;
        vi.restoreAllMocks();
    });

    it('keeps the raw value in the cell and persists the canonical form', () => {
        seedSettings('offline', TEST_OFFLINE_BASE);
        instance = composeUnit(cancelCalls);
        const raw = 'http://alt.test/providers/private/v1///';

        instance.execute<string>(CHAT_PROVIDER_BASE_SET_COMMAND, raw);

        // The cell holds what the operator typed (fluid editing, oracle 3360-3362) while
        // localStorage holds the form the derived routes are built from:
        // api/offline.ts:153-160 strips the trailing slashes.
        expect(instance.state<string>(CHAT_PROVIDER_BASE_STATE).get()).toBe(raw);
        expect(readPersisted()).toBe(
            '{"mode":"offline","providerBase":"http://alt.test/providers/private/v1"}'
        );
    });

    it('does nothing at all for the base that is already live', () => {
        seedSettings('offline', TEST_OFFLINE_BASE);
        instance = composeUnit(cancelCalls);
        const before = readPersisted();

        instance.execute<string>(CHAT_PROVIDER_BASE_SET_COMMAND, TEST_OFFLINE_BASE);

        expect(readPersisted()).toBe(before);
        expect(cancelCalls).toEqual([]);
    });

    it('stops a stream that is running and leaves an idle surface alone', () => {
        seedSettings('offline', TEST_OFFLINE_BASE);
        instance = composeUnit(cancelCalls);
        const activity = instance.service<ChatActivity>(CHAT_ACTIVITY_SERVICE);

        // Nothing in flight: no cancel call, so a composition without chat.source can
        // never reach an `unknown-command`.
        instance.execute<string>(CHAT_PROVIDER_BASE_SET_COMMAND, 'http://one.test/v1');
        expect(cancelCalls).toEqual([]);

        // A stream in flight: the reply arriving from the base the operator just
        // replaced is invalidated, so the cancel command runs exactly once.
        activity.begin('sending');
        instance.execute<string>(CHAT_PROVIDER_BASE_SET_COMMAND, 'http://two.test/v1');
        expect(cancelCalls).toEqual([undefined]);

        activity.end('sending');
        instance.execute<string>(CHAT_PROVIDER_BASE_SET_COMMAND, 'http://three.test/v1');
        expect(cancelCalls).toEqual([undefined]);
    });

    it('re-persists exactly once per real edit, through both the command and the core', () => {
        seedSettings('offline', TEST_OFFLINE_BASE);
        instance = composeUnit(cancelCalls);
        const write = vi.spyOn(Storage.prototype, 'setItem');

        instance.execute<string>(CHAT_PROVIDER_BASE_SET_COMMAND, 'http://four.test/v1');

        // Two writes of one edit is the documented belt (this command persists, and the
        // core's providerBase subscription persists again, plugins/core.ts:575-584).
        expect(write).toHaveBeenCalledTimes(2);
        expect(instance.state<string>(CHAT_ERROR_STATE).get()).toBe('');
        write.mockRestore();
    });
});

describe('settings inside the real composition', () => {
    let instance: Dashboard | null = null;
    let fetchDouble: FetchDouble | null = null;

    beforeEach(() => {
        resetStorage();
    });

    afterEach(() => {
        instance?.dispose();
        instance = null;
        fetchDouble = null;
        vi.unstubAllGlobals();
    });

    it('re-lists the sidebar from the NEW namespace and never keeps the old rows', async () => {
        // Online starts with one server row, offline with one browser-local record; the
        // two histories must never mix (oracle 3371-3381).
        const onlineRow = summaryFixture(recordFixture('server-chat'));
        const localRecord = recordFixture('local-chat');
        upsertLocalConversation(localRecord);
        fetchDouble = installFetch([
            catalogRoute,
            {
                match: (url: string) => url.startsWith(TEST_BASE_URL),
                reply: () => jsonResponse(200, { conversations: [onlineRow] })
            }
        ]);
        // `chat.settings` is registered by the shipped composition now
        // (plugins/extras.ts), so these scenarios run against the REAL graph instead
        // of appending the plugin again — a second registration would discard the
        // whole build with 'duplicate-command'.
        instance = createTestChat();
        await vi.waitFor(() => {
            expect(instance?.state<readonly ChatSession[]>(CHAT_SESSIONS_STATE).get()).toEqual([
                onlineRow
            ]);
        });

        instance.execute<ChatMode>(CHAT_MODE_SET_COMMAND, 'offline');

        // The re-list is owned by the sessions plugin through the mode CELL
        // (plugins/sessions.ts:348-350) — the plugin exposes no callable seam.
        await vi.waitFor(() => {
            expect(instance?.state<readonly ChatSession[]>(CHAT_SESSIONS_STATE).get()).toEqual([
                summaryFixture(localRecord)
            ]);
        });
        expect(instance.state<ChatMode>(CHAT_MODE_STATE).get()).toBe('offline');
    });

    it('re-reads the model catalog from the new base, at its canonical URL', async () => {
        seedSettings('offline', TEST_OFFLINE_BASE);
        seedModel('alpha/flash');
        fetchDouble = installFetch([catalogRoute]);
        // `chat.settings` is registered by the shipped composition now
        // (plugins/extras.ts), so these scenarios run against the REAL graph instead
        // of appending the plugin again — a second registration would discard the
        // whole build with 'duplicate-command'.
        instance = createTestChat();
        await vi.waitFor(() => {
            expect(fetchDouble?.callsFor(`${TEST_OFFLINE_BASE}/models`)).toHaveLength(1);
        });

        instance.execute<string>(
            CHAT_PROVIDER_BASE_SET_COMMAND,
            'http://alt.test/providers/private/v1/'
        );

        // The request goes to the NORMALIZED base: `.../v1//models` would 404 against a
        // real provider, and the doubled slash is exactly what the persist strips.
        await vi.waitFor(() => {
            expect(fetchDouble?.callsFor('http://alt.test/providers/private/v1/models')).toEqual([
                { url: 'http://alt.test/providers/private/v1/models', method: 'GET', body: null }
            ]);
        });
        expect(fetchDouble?.callsFor(`${TEST_OFFLINE_BASE}/models`)).toHaveLength(1);
    });

    it('detaches the stream that was running against the replaced base', async () => {
        seedSettings('offline', TEST_OFFLINE_BASE);
        seedModel('alpha/flash');
        let signal: AbortSignal | undefined;
        fetchDouble = installFetch([
            catalogRoute,
            {
                match: (url: string) => url.endsWith('/chat/completions'),
                reply: (_url: string, init?: RequestInit) => {
                    signal = init?.signal ?? undefined;
                    // The platform's own behavior on abort: the pending request rejects
                    // with an AbortError, which services/provider.ts:190-193 turns into
                    // a resolved `{ aborted: true }` outcome.
                    return new Promise<Response>((_resolve, reject) => {
                        signal?.addEventListener('abort', () => {
                            const reason = new Error('The operation was aborted.');
                            reason.name = 'AbortError';
                            reject(reason);
                        });
                    });
                }
            }
        ]);
        // `chat.settings` is registered by the shipped composition now
        // (plugins/extras.ts), so these scenarios run against the REAL graph instead
        // of appending the plugin again — a second registration would discard the
        // whole build with 'duplicate-command'.
        instance = createTestChat();
        const cells = instance.service<ChatCells>(CHAT_CELLS_SERVICE);
        await vi.waitFor(() => expect(cells.models.get()).toEqual(['alpha/flash', 'zeta/turbo']));

        cells.draft.set('stream me then change the base');
        void instance.execute<void>(CHAT_MESSAGE_SEND_COMMAND);
        await vi.waitFor(() => expect(cells.status.get()).toBe('sending'));
        expect(cells.pending.get()).toEqual({
            text: 'stream me then change the base',
            at: expect.any(Number)
        });
        expect(signal?.aborted).toBe(false);

        instance.execute<string>(CHAT_PROVIDER_BASE_SET_COMMAND, 'http://alt.test/v1');

        // The request is cancelled, its buffers released, and the draft returns to the
        // composer for a retry against the new base (source's stop branch,
        // plugins/source.ts:550-563).
        await vi.waitFor(() => expect(signal?.aborted).toBe(true));
        await vi.waitFor(() => expect(cells.status.get()).toBe('idle'));
        expect(cells.pending.get()).toBeNull();
        expect(cells.streaming.get()).toBe('');
        expect(cells.draft.get()).toBe('stream me then change the base');
        expect(cells.error.get()).toBe('');
    });
});
