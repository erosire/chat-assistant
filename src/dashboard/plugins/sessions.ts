// Chat SESSIONS plugin: the conversation lifecycle.
//
// Ports the four ping-pong flows of the pre-rebuild component, each of which is a
// tracked-id round trip against the ACTIVE mode's storage namespace:
//
//   list    <- the mount effect (components/ChatAssistantApp.tsx:2804-2831): ONLINE
//              asks the server for exactly the browser's TRACKED ids (the ones it
//              created) and prunes ids the server no longer returns; OFFLINE reads
//              the durable browser-local store. `services/conversations.ts` already
//              encodes both rules, so this file only moves the result into
//              `chat.sessions` and reports the failure.
//   select  <- `selectChat` (:3306-3348)
//   create  <- the tracked creation the send/prompt flows perform (:2487-2493 and
//              services/conversations.ts:157-164): POST -> track -> canonical GET.
//   delete  <- `deleteChat` (:3512-3548): DELETE -> untrack -> clear the selection
//              ONLY when the deleted row was the open chat.
//   rename  <- `saveTitle` (:3756-3789): the identified PUT with an explicit
//              `title`, which wins over the server's first-line derivation.
//
// EVERY flow pins its storage namespace with `namespaceStore()` BEFORE its first
// await and re-checks the epoch guard on every settle: the write always lands in
// the mode that started it (so a mid-flight switch loses no history), while the
// record / sidebar row / banner / busy flag are applied only while that mode and
// that surface are still current. That is the oracle's `modeEpoch` discipline
// (:3302-3347) with the session-switch half added, as the T3 brief requires.
//
// The commands return Promises (the contract's `-> void` / `-> string` describe
// the settled value). They NEVER reject: a failure becomes `chat.error` plus a
// `chat.error` event, matching the shipped banner behavior instead of throwing
// across the command boundary.
import type { DashboardPlugin } from '@underload/dashboard';
import type { ChatMessage } from '../../api/chat-assistant';
import {
    CHAT_ACTIVITY_SERVICE,
    CHAT_CELLS_SERVICE,
    CHAT_EPOCH_SERVICE,
    CHAT_ERROR_EVENT,
    CHAT_SESSION_CREATE_COMMAND,
    CHAT_SESSION_DELETE_COMMAND,
    CHAT_SESSION_RENAME_COMMAND,
    CHAT_SESSION_SELECT_COMMAND,
    CHAT_SESSION_SELECTED_EVENT,
    CHAT_SESSION_CREATED_EVENT,
    CHAT_TRANSCRIPT_UPDATED_EVENT,
    PLUGIN_IDS,
    type ChatActivity,
    type ChatCells,
    type ChatEpoch,
    type ChatGuard,
    type ChatMode,
    type ChatPhase,
    type ChatUsage,
    type NoticeEvent,
    type SessionCreatedEvent,
    type SessionRenameInput,
    type SessionSelectedEvent,
    type TranscriptUpdatedEvent
} from '../contract';
import {
    readStoredModel,
    storeStoredModel,
    defaultCollapsedIndices,
    mergeSummary,
    removeSummary,
    summaryFromRecord
} from './core';
import { namespaceStore, readableFailure } from './source';
import { describeChatOptions, type ChatConfig, type ChatPluginOptions } from './options';

/**
 * A conversation read is the boundary between two surfaces: the transcript, the
 * collapse set, the draft prompt and the open editors all belong to the record
 * that was just opened. Written as ONE batch so no half-switched surface is ever
 * observable, and in the order the oracle used (record -> collapse -> close
 * editors -> banner -> selection, :3320-3335).
 * `activeSessionId` is written LAST: it is the cell the core plugin watches to
 * bump the surface epoch, so any later guard check in the caller would invalidate
 * the batch's own remaining writes.
 */
const adoptRecord = (
    cells: ChatCells,
    sessionId: string | null,
    messages: readonly ChatMessage[],
    usage: ChatUsage | null | undefined
): void => {
    const frozen: readonly ChatMessage[] = Object.freeze([...messages]);
    cells.transcript.set(frozen);
    cells.collapsedTurns.set(defaultCollapsedIndices(frozen));
    cells.usage.set(usage ?? null);
    // The draft prompt belongs to the chat being left, and so does any open inline
    // editor (bubble or prompt draft): both are abandoned on a switch.
    cells.systemDraft.set('');
    cells.editingSystem.set(false);
    cells.editingIndex.set(null);
    // Explicit navigation always pins the opened chat to its latest turn
    // (the oracle's one-shot `selectionPin`, :3317-3320).
    cells.autoscroll.set(true);
    // Picking a chat closes the mobile drawer (md+ ignores it via CSS, :3323-3325).
    cells.drawerOpen.set(false);
    cells.error.set('');
    cells.activeSessionId.set(sessionId);
};

export function createSessionsPlugin(options: ChatPluginOptions = {}): DashboardPlugin {
    const config: ChatConfig = describeChatOptions(options);

    return {
        id: PLUGIN_IDS.chatSessions,
        // Reads `chat.cells` + the epoch guard during setup (the initial listing
        // subscribes to `chat.mode`), both registered by the core plugin.
        requires: [PLUGIN_IDS.chatCore],
        setup(api) {
            const cells = api.getService<ChatCells>(CHAT_CELLS_SERVICE);
            const epoch = api.getService<ChatEpoch>(CHAT_EPOCH_SERVICE);
            const activity = api.getService<ChatActivity>(CHAT_ACTIVITY_SERVICE);
            let alive = true;

            /**
             * EPOCH-GATED BUSY RELEASE — the single rule every flow's `finally` uses.
             *
             * WHY `end()` MAY NOT RUN UNGUARDED: a mode switch calls `activity.reset()`
             * for the NEW namespace (plugins/core.ts:542), which drops every count the
             * flows in flight had taken. A stale settle that then calls `end()` blindly
             * decrements a count the NEW namespace just took, so `chat.status` falls to
             * 'idle' while a save or a listing in the new mode is genuinely still
             * running (the reported defect). The oracle gates every one of its
             * finallys identically — `if (modeEpoch() === epochAtStart) flag(false)` at
             * :3296 (prompt save), :3599 (edit), :3787 (rename) and :4143 (send).
             *
             * `namespaceCurrent` (not `surfaceCurrent`) is the right check: leaving a
             * chat mid-request does not invalidate the busy label of a flow that is
             * still running in the SAME namespace.
             */
            const releasePhase = (phase: ChatPhase, guard: ChatGuard): void => {
                if (alive && epoch.namespaceCurrent(guard)) activity.end(phase);
            };

            // The mode/provider options are per-dashboard; the live mode and base
            // are read from the cells, so a settings edit routes the next call.
            const storeFor = (mode: ChatMode): ReturnType<typeof namespaceStore> =>
                namespaceStore(config, mode, cells.providerBase.get());

            // A listing is a one-shot read, but its result still belongs to the
            // namespace that issued it: a mode switch during the GET must not drop
            // the OTHER mode's rows into the new sidebar.
            let listSequence = 0;
            const refreshSessions = async (): Promise<void> => {
                const attempt = ++listSequence;
                const guard = epoch.capture();
                const mode: ChatMode = cells.mode.get() === 'offline' ? 'offline' : 'online';
                const store = storeFor(mode);
                activity.begin('loading');

                try {
                    // ONLINE: the tracked-id cache is the sidebar's authority (the
                    // facade prunes ids the server no longer returns); OFFLINE: the
                    // local store is already browser-scoped, so the facade ignores
                    // the filter (services/conversations.ts:136-155).
                    const rows = await store.list(store.tracked());
                    if (!alive) return;
                    if (attempt !== listSequence) return;
                    if (!epoch.namespaceCurrent(guard)) return;
                    cells.sessions.set(Object.freeze([...rows]));
                    // NOTE: a successful listing does NOT clear `chat.error`. The
                    // oracle's list effect only wrote the banner on failure
                    // (:2820-2822), and the sidebar refresh runs in the background
                    // of every other flow — clearing here would wipe a failure the
                    // operator has not seen yet (a failed send, a rejected rename).
                } catch (reason) {
                    if (!alive) return;
                    if (attempt !== listSequence) return;
                    if (!epoch.namespaceCurrent(guard)) return;
                    const message = readableFailure(reason);
                    cells.error.set(message);
                    api.emit(CHAT_ERROR_EVENT, { message } satisfies NoticeEvent);
                } finally {
                    // Only the newest attempt may clear the busy label, and never
                    // into a namespace that has moved on (see releasePhase).
                    releasePhase('loading', guard);
                }
            };

            const createSession = async (): Promise<string | null> => {
                if (!alive) return null;
                const guard = epoch.capture();
                const mode: ChatMode = cells.mode.get() === 'offline' ? 'offline' : 'online';
                const store = storeFor(mode);
                activity.begin('saving');
                cells.error.set('');
                try {
                    // The record starts EMPTY (the server derives the title from the
                    // first completed pair). `model` is sent only when one is
                    // selected: both stores reject a blank model field
                    // (api/offline.ts:314-328), and a brand-new browser with no
                    // catalog yet has nothing to send.
                    const chosen = cells.model.get() || readStoredModel();
                    const request = chosen ? { model: chosen } : {};
                    const record = await store.create(request);
                    if (!alive) return record.conversationId;
                    if (!epoch.namespaceCurrent(guard)) return record.conversationId;
                    cells.sessions.set((previous) => mergeSummary(previous, summaryFromRecord(record)));
                    const created: SessionCreatedEvent = {
                        sessionId: record.conversationId,
                        title: record.title
                    };
                    api.emit(CHAT_SESSION_CREATED_EVENT, created);
                    adoptRecord(cells, record.conversationId, record.messages, record.usage);
                    const selected: SessionSelectedEvent = { sessionId: record.conversationId };
                    api.emit(CHAT_SESSION_SELECTED_EVENT, selected);
                    const updated: TranscriptUpdatedEvent = {
                        sessionId: record.conversationId,
                        turnCount: record.messages.length
                    };
                    api.emit(CHAT_TRANSCRIPT_UPDATED_EVENT, updated);
                    return record.conversationId;
                } catch (reason) {
                    if (alive && epoch.namespaceCurrent(guard)) {
                        const message = readableFailure(reason);
                        cells.error.set(message);
                        api.emit(CHAT_ERROR_EVENT, { message } satisfies NoticeEvent);
                    }
                    return null;
                } finally {
                    releasePhase('saving', guard);
                }
            };

            const selectSession = async (sessionId: string): Promise<void> => {
                if (!alive) return;
                const guard = epoch.capture();
                const mode: ChatMode = cells.mode.get() === 'offline' ? 'offline' : 'online';
                const store = storeFor(mode);
                activity.begin('loading');
                try {
                    // A missing id rejects with the 404-equivalent message, which
                    // the catch below surfaces in the banner instead of loading a
                    // phantom surface (:3310-3312).
                    const record = await store.read(sessionId);
                    if (!alive) return;
                    // A switch (mode or session) during the fetch: the record
                    // belongs to the surface that has been left, and the newer
                    // selection owns the cells now.
                    if (!epoch.surfaceCurrent(guard)) return;
                    // Inherit the conversation's recorded model ONLY when the
                    // browser has not remembered one yet; the inherited model then
                    // becomes the remembered one (`applyModelMemory`, :3169-3176).
                    // THE GATE IS THE STORED VALUE, NOT THE CELL: the catalog effect
                    // adopts a DEFAULT model into the cell without persisting it
                    // (plugins/source.ts:727-769 suppresses the subscription on purpose,
                    // :760-765), so a fresh browser's cell is already occupied by
                    // something the operator never chose. Gating on `!cells.model.get()`
                    // would then let that silent catalog default outrank the
                    // conversation's own recorded model — exactly the drift the oracle
                    // avoids by reading `readRememberedModel()`.
                    const hadRememberedModel = readStoredModel();
                    if (!hadRememberedModel && record.model) {
                        // Both halves, in the oracle's order (:3173-3174 writes the
                        // selection then remembers it). `storeStoredModel` first, so a
                        // record whose model the cell ALREADY carries still gets
                        // persisted (an equal cell write is a SameValueZero no-op and
                        // would notify the persistence subscription in source.ts not at
                        // all).
                        storeStoredModel(record.model);
                        cells.model.set(record.model);
                    }
                    adoptRecord(cells, record.conversationId, record.messages, record.usage);
                    const selected: SessionSelectedEvent = { sessionId: record.conversationId };
                    api.emit(CHAT_SESSION_SELECTED_EVENT, selected);
                    const updated: TranscriptUpdatedEvent = {
                        sessionId: record.conversationId,
                        turnCount: record.messages.length
                    };
                    api.emit(CHAT_TRANSCRIPT_UPDATED_EVENT, updated);
                } catch (reason) {
                    // A banner belonging to the previous namespace: the switch
                    // already cleared the new one, so a stale failure must not
                    // re-surface it (:3336-3342).
                    if (alive && epoch.namespaceCurrent(guard)) {
                        const message = readableFailure(reason);
                        cells.error.set(message);
                        api.emit(CHAT_ERROR_EVENT, { message } satisfies NoticeEvent);
                    }
                } finally {
                    releasePhase('loading', guard);
                }
            };

            const deleteSession = async (sessionId: string): Promise<void> => {
                if (!alive) return;
                // One delete at a time: the guard is the shared 'saving' label, the
                // oracle's `deleting()` flag (:3513).
                if (activity.isBusy('saving')) return;
                const guard = epoch.capture();
                const mode: ChatMode = cells.mode.get() === 'offline' ? 'offline' : 'online';
                const store = storeFor(mode);
                const wasActive = cells.activeSessionId.get() === sessionId;
                activity.begin('saving');
                try {
                    // The facade untracks the id only AFTER the store confirms the
                    // removal, so a failed DELETE keeps the conversation tracked and
                    // restorable (services/conversations.ts:185-192).
                    await store.remove(sessionId);
                    if (!alive) return;
                    if (!epoch.namespaceCurrent(guard)) return;
                    cells.sessions.set((previous) => removeSummary(previous, sessionId));
                    if (wasActive) {
                        // Deleting the OPEN chat returns to a fresh new-chat
                        // surface; the model selection survives either way
                        // (:3525-3535 and startNewChat, :3476-3496).
                        adoptRecord(cells, null, [], null);
                    }
                    cells.error.set('');
                } catch (reason) {
                    if (alive && epoch.namespaceCurrent(guard)) {
                        const message = readableFailure(reason);
                        cells.error.set(message);
                        api.emit(CHAT_ERROR_EVENT, { message } satisfies NoticeEvent);
                    }
                } finally {
                    releasePhase('saving', guard);
                }
            };

            const renameSession = async (input: SessionRenameInput): Promise<void> => {
                if (!alive) return;
                const sessionId = input?.sessionId ?? '';
                const title = (input?.title ?? '').trim();
                // Blank titles are forbidden (the server derives one from the first
                // user turn), and an unchanged title needs no request at all — both
                // guards of `saveTitle` (:3759-3761).
                if (!sessionId || !title) return;
                // The second half of that guard, which the comment above has always
                // claimed: the sidebar row IS the persisted title this editor was
                // seeded from, so an unchanged name means there is nothing to write.
                // Without it, every no-op blur/Enter in the title field re-PUTs the
                // WHOLE history (the rename rides the identified whole-history PUT) and
                // bumps `updatedAt` for nothing. A row that is not in the sidebar at all
                // (an add-on renaming an unknown id) still falls through and asks.
                const persistedTitle = cells.sessions
                    .get()
                    .find((candidate) => candidate.conversationId === sessionId)?.title;
                if (persistedTitle === title) return;
                const guard = epoch.capture();
                const mode: ChatMode = cells.mode.get() === 'offline' ? 'offline' : 'online';
                const store = storeFor(mode);
                activity.begin('saving');
                try {
                    // The rename rides the whole-history PUT: the history
                    // round-trips unchanged while the explicit title wins over the
                    // server's first-line derivation. The active surface already
                    // holds its messages, so it needs no extra read; any other row
                    // is read first so its history is sent verbatim.
                    const isActive = cells.activeSessionId.get() === sessionId;
                    const messages: ChatMessage[] = isActive
                        ? [...cells.transcript.get()]
                        : (await store.read(sessionId)).messages;
                    if (!isActive && (!alive || !epoch.namespaceCurrent(guard))) return;
                    const record = await store.replace(sessionId, { messages, title });
                    if (!alive) return;
                    if (!epoch.namespaceCurrent(guard)) return;
                    cells.sessions.set((previous) => mergeSummary(previous, summaryFromRecord(record)));
                    if (isActive && epoch.surfaceCurrent(guard)) {
                        adoptRecord(cells, record.conversationId, record.messages, record.usage);
                    }
                    cells.error.set('');
                } catch (reason) {
                    if (alive && epoch.namespaceCurrent(guard)) {
                        const message = readableFailure(reason);
                        cells.error.set(message);
                        api.emit(CHAT_ERROR_EVENT, { message } satisfies NoticeEvent);
                    }
                } finally {
                    releasePhase('saving', guard);
                }
            };

            // ——— commands ——————————————————————————————————————————————————————
            api.command<void, Promise<string | null>>(CHAT_SESSION_CREATE_COMMAND, () =>
                createSession()
            );
            api.command<string, Promise<void>>(CHAT_SESSION_SELECT_COMMAND, (sessionId) =>
                selectSession(sessionId)
            );
            api.command<string, Promise<void>>(CHAT_SESSION_DELETE_COMMAND, (sessionId) =>
                deleteSession(sessionId)
            );
            api.command<SessionRenameInput, Promise<void>>(CHAT_SESSION_RENAME_COMMAND, (input) =>
                renameSession(input)
            );

            // ——— tracked-id listing on mount, and on every mode switch ——————————
            // The two triggers of the oracle's list effect (deps [baseUrl, offline],
            // :2831): the first mount, and a mode change (each mode's sidebar owns
            // its own namespace, so the two histories never mix).
            const onModeChange = cells.mode.subscribe(() => {
                void refreshSessions();
            });

            // Deferred one microtask, so composition finishes (every plugin
            // registered, every service published) before the first request.
            queueMicrotask(() => {
                if (alive) void refreshSessions();
            });

            return () => {
                alive = false;
                onModeChange();
            };
        }
    };
}

/** The default-configured sessions plugin (deployment defaults; see ./chat.ts). */
export const sessionsPlugin: DashboardPlugin = createSessionsPlugin();
