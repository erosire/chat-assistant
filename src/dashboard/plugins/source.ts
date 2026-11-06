// Chat SOURCE plugin: the transport layer of the dashboard.
//
// It publishes the two services every other chat surface consumes, and it owns
// the streaming send pipeline (the ported `submit`, components/ChatAssistantApp.tsx
// :3872-4150), the R14 pending-conversation poller (:2843-2895) and the model
// catalog effect (:2730-2794).
//
// THE MODE-ROUTING FACADE (the part that is easy to get wrong):
//   Services are FROZEN at setup â€” `api.service(id, value)` publishes one object
//   for the life of the dashboard, and `instance.service()` never re-resolves it.
//   But the storage namespace and the provider base are RUNTIME state (Settings
//   flips `chat.mode` / `chat.providerBase` whenever the operator likes). A facade
//   captured at setup would therefore keep talking to the namespace that happened
//   to be active when the dashboard was built. So every method of
//   `chat.conversations` reads the two cells AT CALL TIME and delegates to a
//   freshly built `createConversationStore(mode, { baseUrl, providerBase })`.
//   That is the only correct shape for online/offline switching under a frozen
//   service registry.
//
//   Long-running flows must NOT use the live facade for their writes: a stream
//   that started online and is still running when the user flips to offline has to
//   finish persisting into the ONLINE namespace, or the turn is lost (the oracle
//   captured its `storage` closure for exactly this reason â€” :2477-2503, :4064).
//   Every such flow therefore pins ONE store with `namespaceStore()` before its
//   first await and keeps that pinned store throughout. The facade stays the live
//   routing seam for one-shot reads issued by other plugins' commands.
//
// NO REACT, NO JSX. DOM-free: everything this file touches is the cells, the two
// facades and the fetch layer behind them.
import type { DashboardPlugin } from '@underload/dashboard';
import { isString } from '@presource/core';
import {
    isConversationPending,
    type ChatMessage,
    type ConversationRecord
} from '../../api/chat-assistant';
import { agentPrefixMessages } from '../../agents';
import {
    CHAT_ACTIVITY_SERVICE,
    CHAT_CELLS_SERVICE,
    CHAT_CONVERSATIONS_SERVICE,
    CHAT_EPOCH_SERVICE,
    CHAT_ERROR_EVENT,
    CHAT_MESSAGE_CANCEL_COMMAND,
    CHAT_MESSAGE_SEND_COMMAND,
    CHAT_PROVIDER_SERVICE,
    CHAT_SESSION_CREATED_EVENT,
    CHAT_SESSION_SELECTED_EVENT,
    CHAT_STATUS_STATE,
    CHAT_STREAM_CANCELLED_EVENT,
    CHAT_STREAM_COMPLETED_EVENT,
    CHAT_STREAM_DELTA_EVENT,
    CHAT_STREAM_STARTED_EVENT,
    CHAT_TRANSCRIPT_UPDATED_EVENT,
    CHAT_VOICE_STOP_COMMAND,
    PLUGIN_IDS,
    type ChatActivity,
    type ChatCells,
    type ChatEpoch,
    type ChatGuard,
    type ChatMode,
    type ChatPendingTurn,
    type NoticeEvent,
    type SessionCreatedEvent,
    type SessionSelectedEvent,
    type StreamCancelledEvent,
    type StreamCompletedEvent,
    type StreamDeltaEvent,
    type StreamStartedEvent,
    type TranscriptUpdatedEvent
} from '../contract';
import {
    createConversationStore,
    type ConversationStore,
    type ConversationStoreMode
} from '../services/conversations';
import { createProviderClient, type ProviderClient } from '../services/provider';
import {
    defaultCollapsedIndices,
    isUnstartedTranscript,
    mergeSummary,
    readStoredModel,
    removeSummary,
    resolveAgentPrefix,
    storeStoredModel,
    summaryFromRecord
} from './core';
import { describeChatOptions, type ChatConfig, type ChatPluginOptions } from './options';

// A readable, actionable explanation for an unconfigured OFFLINE provider base,
// surfaced in the banner instead of a silent request to the default app server
// (components/ChatAssistantApp.tsx:4003-4008; the same guard lives inside
// services/provider.ts:72-73).
export const OFFLINE_BASE_REQUIRED =
    'Configure the offline provider base URL in Settings (for example, http://192.168.50.109:5500/providers/private/v1) to stream model replies offline â€” the model catalog lives under its /models route and replies stream from /chat/completions; the default app server is not used in offline mode.';

/**
 * The storage namespace of ONE mode, built from the resolved deployment endpoint
 * plus the provider base that was live at the moment of the call.
 * Exported for the sibling chat plugins (sessions / transcript / system-prompt),
 * which pin a store before their first await for the same captured-namespace
 * reason the source plugin does.
 */
export const namespaceStore = (
    config: ChatConfig,
    mode: ChatMode,
    providerBase: string
): ConversationStore =>
    createConversationStore(mode === 'offline' ? 'offline' : 'online', {
        baseUrl: config.baseUrl,
        providerBase
    });

/** Any thrown value -> the readable banner text the oracle showed. */
export const readableFailure = (reason: unknown): string => {
    if (reason instanceof Error) return reason.message;
    if (isString(reason)) return reason;
    return String(reason);
};

/** One in-flight stream, plus everything the cancel/rollback paths need. */
type InflightSend = {
    requestId: string;
    /** The surface the send started on (null = the new-chat surface). */
    sessionId: string | null;
    model: string;
    controller: AbortController | null;
    /** Set by `chat.message.cancel` so the settle takes the cancel branch. */
    cancelled: boolean;
};

/** The in-flight conversation the R14 poller follows (the oracle's `pendingConversationId`). */
type WatchTarget = {
    sessionId: string;
    store: ConversationStore;
    guard: ChatGuard;
    timer: ReturnType<typeof setInterval>;
};

export function createSourcePlugin(options: ChatPluginOptions = {}): DashboardPlugin {
    const config: ChatConfig = describeChatOptions(options);

    return {
        id: PLUGIN_IDS.chatSource,
        // The core plugin owns the cells and the epoch guard, and this setup reads
        // BOTH during setup (it subscribes to the cells and publishes facades over
        // them), so the edge is mandatory: `requires` is what makes a setup-time
        // service read defined rather than a lucky coincidence.
        requires: [PLUGIN_IDS.chatCore],
        setup(api) {
            const cells = api.getService<ChatCells>(CHAT_CELLS_SERVICE);
            const epoch = api.getService<ChatEpoch>(CHAT_EPOCH_SERVICE);
            const activity = api.getService<ChatActivity>(CHAT_ACTIVITY_SERVICE);
            // Teardown flag: every async settle checks it before touching a cell,
            // because a write to a DETACHED cell throws 'disposed'
            // (packages/underload/dashboard/src/extensions/state.ts:42-46).
            let alive = true;

            // â€”â€”â€” `chat.conversations`: the mode-routing facade â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”
            // Built ONCE; every method resolves the live mode/base per call (see
            // the header). `mode` is a getter so a consumer reading
            // `conversations.mode` also sees the live value.
            const routed = (): ConversationStore =>
                namespaceStore(config, cells.mode.get(), cells.providerBase.get());
            const conversations: ConversationStore = {
                get mode(): ConversationStoreMode {
                    return cells.mode.get() === 'offline' ? 'offline' : 'online';
                },
                list: (ids: string[]) => routed().list(ids),
                create: (input) => routed().create(input),
                read: (id: string) => routed().read(id),
                append: (id: string, input) => routed().append(id, input),
                replace: (id: string, input) => routed().replace(id, input),
                remove: (id: string) => routed().remove(id),
                tracked: () => routed().tracked(),
                track: (id: string) => routed().track(id),
                untrack: (id: string) => routed().untrack(id)
            };
            api.service<ConversationStore>(CHAT_CONVERSATIONS_SERVICE, conversations);

            // â€”â€”â€” `chat.provider`: the ONLINE relay client â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”
            // One client bound to the deployment provider base. OFFLINE mode
            // streams through a client bound to `chat.providerBase` instead (the
            // standard routes derive identically, api/provider.ts:213-235); those
            // clients are cached per base so a settings edit does not rebuild the
            // transport on every send.
            const onlineClient = createProviderClient(config.providerUrl);
            api.service<ProviderClient>(CHAT_PROVIDER_SERVICE, onlineClient);

            const offlineClients = new Map<string, ProviderClient>();
            const offlineClient = (base: string): ProviderClient => {
                // The cache key is the canonical base form (trimmed, no trailing
                // slashes) so 'http://h:5500/p/v1/' and 'http://h:5500/p/v1' share
                // one client â€” services/provider.ts:78 normalizes both anyway.
                const key = base.trim().replace(/\/+$/, '');
                const cached = offlineClients.get(key);
                if (cached) return cached;
                const client = createProviderClient(key);
                offlineClients.set(key, client);
                return client;
            };
            // The transport a flow in `mode` streams through, pinned to the base
            // that was live when the flow started.
            const streamClientFor = (mode: ChatMode, providerBase: string): ProviderClient =>
                mode === 'offline' ? offlineClient(providerBase) : onlineClient;

            // â€”â€”â€” the send snapshot (the oracle's `activeSend`) â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”
            let inflight: InflightSend | null = null;
            let requestSequence = 0;

            // â€”â€”â€” the R14 poller â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”
            // Scoped to the ONE id this browser has a live request for, exactly the
            // oracle's `pendingConversationId` watch target
            // (components/ChatAssistantApp.tsx:2611, :2843-2895): the timer exists
            // only for the duration of a real request, so a settled conversation is
            // never polled and a pending record left behind by a closed tab is not
            // polled forever (nothing is waiting on it). OFFLINE never polls â€”
            // there is no server to follow, and the local store is written settled
            // (:2844).
            let watch: WatchTarget | null = null;

            const stopWatch = (): void => {
                if (watch === null) return;
                clearInterval(watch.timer);
                watch = null;
            };

            /** One poll tick: merge the sidebar row, adopt the record once settled. */
            const pollOnce = async (): Promise<void> => {
                const target = watch;
                if (target === null) return;
                if (!epoch.namespaceCurrent(target.guard)) {
                    stopWatch();
                    return;
                }
                try {
                    const record = await target.store.read(target.sessionId);
                    // A mode switch during the read detaches the result: the other
                    // namespace's sidebar and surface own themselves now.
                    if (watch !== target || !epoch.namespaceCurrent(target.guard)) return;
                    cells.sessions.set((previous) => mergeSummary(previous, summaryFromRecord(record)));
                    // Still in flight: the surface belongs to the send flow, only
                    // the sidebar row follows the server here.
                    if (isConversationPending(record.status)) return;
                    // An ONGOING send on this very conversation owns the surface:
                    // its completion applies the canonical record, so adopting a
                    // pre-turn snapshot now would yank the in-flight bubbles away.
                    if (inflight !== null) return;
                    if (cells.activeSessionId.get() !== target.sessionId) {
                        // Settled while the operator was looking at another chat:
                        // the row is updated, the watch is done.
                        stopWatch();
                        return;
                    }
                    // Settled server-side (another tab, a retried send, a
                    // server-side completion): adopt it so the open chat shows the
                    // finished turn without waiting for a reload.
                    const messages: readonly ChatMessage[] = Object.freeze([...record.messages]);
                    cells.transcript.set(messages);
                    cells.collapsedTurns.set(defaultCollapsedIndices(messages));
                    cells.usage.set(record.usage ?? null);
                    stopWatch();
                    const updated: TranscriptUpdatedEvent = {
                        sessionId: target.sessionId,
                        turnCount: messages.length
                    };
                    api.emit(CHAT_TRANSCRIPT_UPDATED_EVENT, updated);
                } catch (reason) {
                    if (watch !== target || !epoch.namespaceCurrent(target.guard)) return;
                    // A conversation that vanished server-side stops being watched
                    // and is untracked; any other failure keeps the timer running
                    // (the next tick retries while the request is still in flight).
                    if (readableFailure(reason).includes('not found')) {
                        conversations.untrack(target.sessionId);
                        cells.sessions.set((previous) =>
                            removeSummary(previous, target.sessionId)
                        );
                        stopWatch();
                    }
                }
            };

            /**
             * Arm (or re-arm) the watch for one id in one namespace. Re-arming for
             * the same id keeps the running cadence; a different id restarts it with
             * the store of the namespace that owns it.
             */
            const armWatch = (sessionId: string, store: ConversationStore): void => {
                if (watch !== null && watch.sessionId === sessionId) return;
                stopWatch();
                watch = {
                    sessionId,
                    store,
                    guard: epoch.capture(),
                    timer: setInterval(() => void pollOnce(), config.pollIntervalMs)
                };
            };

            /**
             * Re-derive the watch target from STATE rather than from events (the
             * framework's rule: state is truth, events are live-only). Two things
             * arm it, exactly the oracle's two `pendingConversationId` assignments
             * (components/ChatAssistantApp.tsx:3987, :3994):
             *   - an in-flight send owns the watch for its whole duration (the send
             *     armed it explicitly, with its OWN pinned namespace, so nothing
             *     here may touch it);
             *   - otherwise, a selected conversation whose sidebar row still says
             *     'pending' is followed until it settles â€” the case the R14 poller
             *     exists for (another tab or a server-side completion finishing the
             *     turn this browser is looking at).
             * OFFLINE never polls (no server to follow, :2844), and a session or
             * mode switch lands here through the cell subscriptions below, which is
             * how "stop on session switch / mode change" happens without any plugin
             * having to call into this one.
             */
            const syncWatch = (): void => {
                if (inflight !== null) return;
                const sessionId = cells.activeSessionId.get();
                const row =
                    sessionId === null
                        ? undefined
                        : cells.sessions.get().find(
                            (candidate) => candidate.conversationId === sessionId
                        );
                if (
                    cells.mode.get() === 'offline' ||
                    sessionId === null ||
                    row === undefined ||
                    !isConversationPending(row.status)
                ) {
                    stopWatch();
                    return;
                }
                armWatch(
                    sessionId,
                    namespaceStore(config, cells.mode.get(), cells.providerBase.get())
                );
            };

            // â€”â€”â€” the leading block a new chat opens with â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”
            /**
             * Ported verbatim from components/ChatAssistantApp.tsx:3934-3960. An
             * agent chosen for new chats supplies its system prompt PLUS its example
             * conversation (agentPrefixMessages) and REPLACES the chat's own system
             * turn; with no agent, the local prompt draft prepends one system
             * message, and only while the record has no leading system turn. Blank
             * prompts and blank example turns are dropped by agentPrefixMessages
             * itself, never as empty provider messages.
             * The block attaches only while the chat has not really started (a blank
             * surface or a prompt-only record), so a later send can never duplicate
             * the example turns.
             */
            const buildHistory = (
                text: string
            ): {
                history: ChatMessage[];
                systemPrefix: ChatMessage[];
                baseMessages: ChatMessage[];
            } => {
                const transcript = cells.transcript.get();
                const agent = resolveAgentPrefix(cells.agents.get(), cells.agent.get());
                const agentBlock: ChatMessage[] =
                    agent && isUnstartedTranscript(transcript)
                        ? [...agentPrefixMessages(agent)]
                        : [];
                // An attached agent block replaces the chat's own system prompt
                // block, so the record's leading system turn is dropped alongside it.
                const baseMessages: ChatMessage[] =
                    agentBlock.length > 0
                        ? transcript.filter((message) => message.role !== 'system')
                        : [...transcript];
                const leadsWithSystem = transcript[0]?.role === 'system';
                const prompt = agent || leadsWithSystem ? '' : cells.systemDraft.get().trim();
                const systemPrefix: ChatMessage[] =
                    agentBlock.length > 0
                        ? agentBlock
                        : prompt
                            ? [{ role: 'system', content: prompt }]
                            : [];
                const history: ChatMessage[] = [
                    ...systemPrefix,
                    ...baseMessages,
                    { role: 'user', content: text }
                ];
                return { history, systemPrefix, baseMessages };
            };

            /**
             * Release the shared in-flight buffers, but ONLY while this request
             * still owns them: a superseded completion must never clear a newer
             * send's buffers (:2600-2604, :4089-4095).
             */
            const releaseBuffers = (requestId: string): void => {
                if (inflight === null || inflight.requestId !== requestId) return;
                inflight = null;
                cells.pending.set(null);
                cells.streaming.set('');
                activity.end('sending');
                // The send no longer owns the watch, so the state-derived rule gets
                // the last word: a row that is STILL 'pending' (a failed rollback
                // cleanup, a slow server settle) keeps being followed.
                syncWatch();
            };

            /**
             * Roll back the up-front 'pending' record a failed or stopped turn
             * created: a generation that never produced a reply must leave no
             * phantom conversation behind (the "saves nothing" contract,
             * :4113-4131). Best-effort: a failed cleanup leaves a tracked, empty
             * record the operator can delete by hand, and never surfaces a second
             * error over the real one.
             */
            const rollBackPendingRecord = async (
                store: ConversationStore,
                createdPending: string | null,
                guard: ChatGuard
            ): Promise<void> => {
                if (createdPending === null) return;
                try {
                    await store.remove(createdPending);
                } catch {
                    // Ignored on purpose (see the doc comment).
                }
                if (!alive || !epoch.namespaceCurrent(guard)) return;
                cells.sessions.set((previous) => removeSummary(previous, createdPending));
            };

            /**
             * Halt a live voice session at the head of a send (S1) — the ported half of
             * the oracle's `submit()` opening, `recognizer()?.dispose();
             * recognizer(null); listening(false);` (:3874-3879).
             *
             * WHY A CALL AND NOT ONLY THE EVENT: `chat.voice` also halts itself on
             * `chat.stream.started` (plugins/voice.ts), which covers every producer of a
             * stream — but that event is emitted only AFTER the online new-chat POST has
             * created the pending record (:525-550), while `send()` reads and clears the
             * draft here (:464/:506). A recognizer left running through that round-trip
             * rewrites the just-cleared composer with stale transcript text, which is the
             * bug. Halting here matches the oracle's ordering; the event subscription
             * stays as the seam for every other caller. Both are idempotent.
             *
             * `chat.voice.stop` is the contract's "put the microphone down" command
             * (silent teardown, keeps the partial transcript for review). It is wrapped
             * because `chat.voice` is an ADD-ON: the headless chat set
             * (plugins/chat.ts) registers no such command, and an `unknown-command`
             * throw must never take a send down.
             */
            const haltVoiceSession = (): void => {
                try {
                    api.execute<void, boolean>(CHAT_VOICE_STOP_COMMAND);
                } catch {
                    // No voice plugin in this composition: nothing to halt.
                }
            };

            const send = async (): Promise<void> => {
                if (!alive) return;
                // S1: put the microphone down BEFORE the draft is read (the oracle does
                // exactly this at :3874-3879), so the transcript written so far is the
                // text that gets sent and the engine cannot rewrite the composer during
                // the provider round-trip. See `haltVoiceSession` for why this is a call
                // and not only the `chat.stream.started` event.
                haltVoiceSession();
                const text = cells.draft.get().trim();
                const chosenModel = cells.model.get();
                // A blank draft or an unselected model never reaches the network, a
                // second send cannot interleave into a running stream, and a prompt
                // blur save owns the conversation write until it completes
                // (:3882-3890 â€” the oracle read `savingSystemPrompt()`, which this
                // model expresses as the single 'saving' status label).
                if (!text || !chosenModel) return;
                if (inflight !== null || activity.isBusy('saving')) return;

                // Snapshot BEFORE the first await: the namespace the writes land
                // in, the surface the reply belongs to, and the staleness guard.
                const guard = epoch.capture();
                const startSessionId = cells.activeSessionId.get();
                const mode: ChatMode = cells.mode.get() === 'offline' ? 'offline' : 'online';
                const providerBase = cells.providerBase.get();
                const store = namespaceStore(config, mode, providerBase);
                const client = streamClientFor(mode, providerBase);

                requestSequence += 1;
                const requestId = `request-${requestSequence}`;
                const controller =
                    typeof AbortController === 'function' ? new AbortController() : null;
                inflight = {
                    requestId,
                    sessionId: startSessionId,
                    model: chosenModel,
                    controller,
                    cancelled: false
                };

                const { history, systemPrefix, baseMessages } = buildHistory(text);

                activity.begin('sending');
                cells.error.set('');
                // Hand the composer text to the pending bubble, then clear the
                // draft: the in-flight turn renders live, BEFORE persistence
                // (:3915-3918). `at` is the wall-clock submission instant the
                // loading affordance reports.
                const pendingTurn: ChatPendingTurn = Object.freeze({ text, at: Date.now() });
                cells.pending.set(pendingTurn);
                cells.streaming.set('');
                cells.draft.set('');

                // ONLINE new chat: create the record BEFORE generating, marked
                // 'pending', so the id exists (and is tracked) for the whole
                // generation window â€” that id is exactly what the poller watches,
                // and a reload during generation restores the chat instead of
                // losing it (:3961-3995). OFFLINE keeps the original order (create
                // after the stream): there is no server to poll, so the local
                // record is written settled. Declared outside the try so the
                // failure path can roll it back.
                let createdPending: string | null = null;
                // The id the completed turn belongs to (announced on the stream
                // events; '' only for an OFFLINE new chat, which has no id until
                // the pair is persisted).
                let announcedId = startSessionId ?? '';
                // The canonical settled record, kept for the summary/usage apply.
                let settled: ConversationRecord | null = null;

                try {
                    if (startSessionId === null && mode === 'online') {
                        const created = await store.create({
                            model: chosenModel,
                            status: 'pending'
                        });
                        createdPending = created.conversationId;
                        announcedId = created.conversationId;
                        if (alive && epoch.surfaceCurrent(guard)) {
                            // The pending row appears immediately: a record that
                            // starts EMPTY (the server derives the title from the
                            // completed pair) is still visible, tracked and pollable.
                            cells.sessions.set((previous) =>
                                mergeSummary(previous, summaryFromRecord(created))
                            );
                        }
                        armWatch(created.conversationId, store);
                    } else if (startSessionId !== null && mode === 'online') {
                        // An ongoing request on an already-tracked conversation: the
                        // record is not marked pending (its history is only rewritten
                        // when the turn completes), but the id is still watched for
                        // the duration of the request, exactly like the create path.
                        armWatch(startSessionId, store);
                    }

                    const started: StreamStartedEvent = { sessionId: announcedId, requestId };
                    api.emit(CHAT_STREAM_STARTED_EVENT, started);

                    // No silent call to the default app server in offline mode: a
                    // blank base rejects with the configuration explanation.
                    if (mode === 'offline' && providerBase.trim().length === 0) {
                        throw new Error(OFFLINE_BASE_REQUIRED);
                    }

                    // Per-token snapshot: live deltas land in `chat.streaming` ONLY
                    // while this send's surface is still current â€” a stream whose
                    // mode or session was switched away settles silently, its
                    // persisted record staying in the captured namespace
                    // (:3908-3914). `stream()` builds the OpenAI-compatible payload
                    // `{ model, stream: true, stream_options: { include_usage: true },
                    // messages }` (api/provider.ts:146-151) and hands back the
                    // ACCUMULATED text plus the final usage frame.
                    const result = await client.stream({
                        model: chosenModel,
                        messages: history,
                        ...(controller ? { signal: controller.signal } : {}),
                        onDelta: (accumulated: string): void => {
                            if (!alive || !epoch.surfaceCurrent(guard)) return;
                            cells.streaming.set(accumulated);
                            const delta: StreamDeltaEvent = {
                                sessionId: announcedId,
                                requestId,
                                text: accumulated
                            };
                            api.emit(CHAT_STREAM_DELTA_EVENT, delta);
                        }
                    });

                    // A stopped stream RESOLVES (it does not reject) with whatever
                    // text arrived. Nothing is persisted: the operator pressed stop,
                    // so the draft goes back into the composer for a retry.
                    if (inflight?.cancelled === true || result.aborted) {
                        await rollBackPendingRecord(store, createdPending, guard);
                        stopWatch();
                        if (alive && epoch.surfaceCurrent(guard)) {
                            const cancelled: StreamCancelledEvent = {
                                sessionId: announcedId,
                                requestId,
                                text: result.content
                            };
                            api.emit(CHAT_STREAM_CANCELLED_EVENT, cancelled);
                            cells.draft.set(text);
                        }
                        releaseBuffers(requestId);
                        return;
                    }

                    // Per-message attribution: the assistant turn records the model
                    // that produced it, so every response stays marked after reload
                    // (:4011-4013). `usage` is attached only when the provider
                    // reported it â€” a gateway with no usage frame must not overwrite
                    // the record's aggregate with an explicit undefined (:4029).
                    const assistantMessage: ChatMessage = {
                        role: 'assistant',
                        content: result.content,
                        model: chosenModel
                    };
                    const userMessage: ChatMessage = { role: 'user', content: text };
                    const usageInput = result.usage ? { usage: result.usage } : {};

                    let conversationId = startSessionId;
                    if (conversationId === null) {
                        // New chat: reuse the pending record created above when
                        // there was one, otherwise create now (the offline path),
                        // then append the completed pair. The conversation started
                        // EMPTY, so the append order is exactly
                        // [system?, user, assistant].
                        conversationId =
                            createdPending ??
                            (await store.create({ model: chosenModel })).conversationId;
                        settled = await store.append(conversationId, {
                            messages: [...systemPrefix, userMessage, assistantMessage],
                            model: chosenModel,
                            ...usageInput
                        });
                    } else if (systemPrefix.length > 0) {
                        // An existing chat gaining its FIRST leading block: an
                        // append can only attach to the END, so the whole history is
                        // replaced through the identified PUT to keep the block at
                        // index 0 (an agent block also drops the record's previous
                        // system turn) (:4032-4042).
                        settled = await store.replace(conversationId, {
                            messages: [
                                ...systemPrefix,
                                ...baseMessages,
                                userMessage,
                                assistantMessage
                            ],
                            ...usageInput
                        });
                    } else {
                        // Regular turn on an existing chat: append the completed
                        // pair; the facade answers with the canonical record.
                        settled = await store.append(conversationId, {
                            messages: [userMessage, assistantMessage],
                            model: chosenModel,
                            ...usageInput
                        });
                    }
                    announcedId = settled.conversationId;

                    // A completed turn makes this model the browser's remembered
                    // last-used one, mode-agnostic: remembered models survive mode
                    // switches by design (:4081-4083).
                    storeStoredModel(chosenModel);

                    // The request is over: stop watching the id, and settle the
                    // sidebar row to the canonical record. The row is refreshed in
                    // the SENDING namespace even when the operator navigated away,
                    // so the completed turn stays discoverable there (:4096-4105).
                    if (watch !== null && watch.sessionId === settled.conversationId) stopWatch();
                    if (alive && epoch.namespaceCurrent(guard)) {
                        const summary = summaryFromRecord(settled);
                        cells.sessions.set((previous) => mergeSummary(previous, summary));
                        const created: SessionCreatedEvent = {
                            sessionId: summary.conversationId,
                            title: summary.title
                        };
                        api.emit(CHAT_SESSION_CREATED_EVENT, created);
                    }

                    // SURFACE + EPOCH GUARD: the fresh record applies ONLY while the
                    // operator has not navigated away and the mode has not changed
                    // (:4053-4080). Applying it to a switched-away chat would yank
                    // the view back to the sending conversation; the storage write
                    // above already landed in the sending namespace, so no history
                    // is lost. The surface writes happen as ONE batch, with the
                    // session id written LAST because adopting a new-chat record into
                    // a session is itself a surface switch (it bumps the guard).
                    if (alive && epoch.surfaceCurrent(guard)) {
                        const messages: readonly ChatMessage[] = Object.freeze([...settled.messages]);
                        cells.transcript.set(messages);
                        cells.collapsedTurns.set(defaultCollapsedIndices(messages));
                        cells.usage.set(settled.usage ?? null);
                        // The draft prompt is now persisted (or was never needed):
                        // clear it and its editor, returning the system turn to the
                        // persisted message's chrome.
                        cells.systemDraft.set('');
                        cells.editingSystem.set(false);
                        cells.editingIndex.set(null);
                        if (cells.activeSessionId.get() !== settled.conversationId) {
                            cells.activeSessionId.set(settled.conversationId);
                        }
                        const updated: TranscriptUpdatedEvent = {
                            sessionId: settled.conversationId,
                            turnCount: messages.length
                        };
                        api.emit(CHAT_TRANSCRIPT_UPDATED_EVENT, updated);
                        const selected: SessionSelectedEvent = {
                            sessionId: settled.conversationId
                        };
                        api.emit(CHAT_SESSION_SELECTED_EVENT, selected);
                    }

                    releaseBuffers(requestId);
                    const completed: StreamCompletedEvent = {
                        sessionId: announcedId,
                        requestId,
                        text: result.content
                    };
                    api.emit(CHAT_STREAM_COMPLETED_EVENT, completed);
                } catch (reason) {
                    // EPOCH GUARD: failures (including the offline blank-endpoint
                    // rejection) surface in the banner only in the namespace that
                    // sent â€” the NEW mode's banner and draft must not receive the
                    // stale operation's error (:4107-4144).
                    const senderStillCurrent = alive && epoch.namespaceCurrent(guard);
                    if (createdPending !== null) {
                        await rollBackPendingRecord(store, createdPending, guard);
                    }
                    if (
                        senderStillCurrent &&
                        watch !== null &&
                        watch.sessionId === (createdPending ?? startSessionId)
                    ) {
                        // The request is over (and its record may be gone).
                        stopWatch();
                    }
                    if (senderStillCurrent) {
                        const message = readableFailure(reason);
                        cells.error.set(message);
                        const failure: NoticeEvent = { message };
                        api.emit(CHAT_ERROR_EVENT, failure);
                        // Restore the draft so a failed stream can be retried
                        // without retyping â€” only on the surface that sent it: a
                        // navigated-away chat owns its own composer.
                        if (epoch.surfaceCurrent(guard)) cells.draft.set(text);
                    }
                    releaseBuffers(requestId);
                }
            };

            // â€”â€”â€” the model catalog (ported mount/switch effect) â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”
            // ONLINE reads the private relay catalog (`providerUrl`). OFFLINE reads
            // the standard route derived from the single configured base
            // (`{base}/models`); a BLANK base issues NO request at all, the
            // remembered model (if any) keeps the composer usable, and the default
            // app server is never called silently (:2730-2766).
            // The sequence number is the `cancelled` flag of the oracle's effect: a
            // stale in-flight response may never land after a newer configuration
            // already owns the catalog cell (no cross-mode mixing, :2749/:2787).
            let catalogSequence = 0;
            // Suppresses the persistence subscription for the ONE change the oracle
            // deliberately did not persist (the catalog default adoption), while
            // every real model pick, inherited record model and completed turn still
            // writes MODEL_STORAGE_KEY. State stays truth: the cell is still the
            // single place the selection lives.
            let persistSuppressed = false;
            const adoptSilently = (id: string): void => {
                persistSuppressed = true;
                try {
                    cells.model.set(id);
                } finally {
                    persistSuppressed = false;
                }
            };
            const refreshModels = async (): Promise<void> => {
                const attempt = ++catalogSequence;
                const guard = epoch.capture();
                const mode: ChatMode = cells.mode.get() === 'offline' ? 'offline' : 'online';
                const base = cells.providerBase.get();
                if (mode === 'offline' && base.trim().length === 0) {
                    // Unconfigured catalog: NO fetch. A remembered model (if any)
                    // keeps the composer usable; there is no manual model to ask for.
                    if (!cells.model.get()) {
                        const initial = readStoredModel();
                        if (initial) adoptSilently(initial);
                    }
                    return;
                }
                try {
                    const ids = await streamClientFor(mode, base).catalog();
                    if (!alive) return;
                    if (attempt !== catalogSequence) return;
                    if (!epoch.namespaceCurrent(guard)) return;
                    // `catalog()` is already deduplicated and sorted by the STRIPPED
                    // model name, so the picker order and the fresh-browser default
                    // follow model names rather than organisation prefixes
                    // (services/provider.ts:135-153).
                    cells.models.set(Object.freeze([...ids]));
                    // Priority: remembered last-used model, else the first sorted
                    // catalog entry. The catalog default itself is NOT persisted â€”
                    // only explicit picks and models that produced a turn are
                    // remembered (:2776-2782) â€” so the adoption below writes the cell
                    // with the persistence subscription suppressed for exactly one
                    // change. A first-run browser therefore keeps following the
                    // catalog's own order until the operator actually chooses.
                    if (!cells.model.get()) {
                        const initial = readStoredModel() || ids[0] || '';
                        if (initial) adoptSilently(initial);
                    }
                } catch (reason) {
                    if (!alive) return;
                    if (attempt !== catalogSequence) return;
                    if (!epoch.namespaceCurrent(guard)) return;
                    // A failed catalog fetch surfaces in the banner as-is: the
                    // picker stays empty until the base is fixed, and a remembered
                    // model still unblocks sending.
                    const message = readableFailure(reason);
                    cells.error.set(message);
                    api.emit(CHAT_ERROR_EVENT, { message } satisfies NoticeEvent);
                }
            };

            // â€”â€”â€” commands â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”
            api.command<void, Promise<void>>(CHAT_MESSAGE_SEND_COMMAND, () => send());

            api.command<void, boolean>(CHAT_MESSAGE_CANCEL_COMMAND, () => {
                const current = inflight;
                if (current === null) return false;
                // A stop that already landed is not a second stop: the control is
                // winding the stream down, and reporting true again would let a
                // double-click claim it had cancelled something new.
                if (current.cancelled) return false;
                // Flag FIRST, so the settle recognises the abort as a user stop
                // rather than a provider failure even if the rejection wins the
                // race; then cancel the request itself.
                current.cancelled = true;
                try {
                    current.controller?.abort();
                } catch {
                    // A transport without abort support still resolves; the flag
                    // keeps the settle on the cancel branch.
                }
                return true;
            });

            // â€”â€”â€” reactive subscriptions (state is truth, events are live-only) â€”â€”
            // Mode / provider-base changes move the catalog: the same re-run rule
            // the oracle encoded in its effect deps ([providerUrl, offline,
            // settings().providerBase], :2794). A mode switch also detaches the
            // previous namespace's watch, whose poller must not resume here
            // (:2849, :3402-3404).
            const onModeChange = cells.mode.subscribe(() => {
                stopWatch();
                syncWatch();
                void refreshModels();
            });
            const onProviderBaseChange = cells.providerBase.subscribe(() => {
                void refreshModels();
            });
            // The watch target follows the sidebar rows and the opened session, so
            // a session switch or a settle anywhere in the graph re-derives it
            // without any cross-plugin call.
            const onSessionsChange = cells.sessions.subscribe(syncWatch);
            const onActiveSessionChange = cells.activeSessionId.subscribe(syncWatch);
            // Every model change re-persists the remembered selection, so a reload
            // preselects it (MODEL_STORAGE_KEY, :1787-1802). On change rather than
            // inside one command because several surfaces move the model (a catalog
            // default, a selected chat, a completed turn) and each of them must
            // persist through the same path.
            const onModelChange = cells.model.subscribe(() => {
                if (alive && !persistSuppressed) storeStoredModel(cells.model.get());
            });

            // Initial catalog load â€” the oracle's mount effect. Deferred one
            // microtask so `createChatDashboard()` stays synchronous and every
            // plugin stays registered before the first request leaves.
            queueMicrotask(() => {
                if (alive) void refreshModels();
            });

            return () => {
                alive = false;
                stopWatch();
                onModeChange();
                onProviderBaseChange();
                onSessionsChange();
                onActiveSessionChange();
                onModelChange();
                const current = inflight;
                inflight = null;
                try {
                    current?.controller?.abort();
                } catch {
                    // Teardown: the request is being dropped anyway.
                }
            };
        }
    };
}

/** The default-configured source plugin (deployment defaults; see ./chat.ts). */
export const sourcePlugin: DashboardPlugin = createSourcePlugin();

// Kept for the type-level assertions in the tests: the cells the send pipeline
// writes are exactly the ones the composer and the status chip read.
export type SendWrittenCells = Pick<
    ChatCells,
    'status' | 'error' | 'draft' | 'pending' | 'streaming' | 'transcript'
>;
