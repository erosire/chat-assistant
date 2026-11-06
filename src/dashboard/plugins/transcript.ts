// Chat TRANSCRIPT plugin: message and turn commands.
//
// Ports the per-turn flows of components/ChatAssistantApp.tsx, all of which are
// "rewrite the whole history through the identified PUT, then adopt the canonical
// record":
//
//   copy    <- `copyMessage` (:3649-3678). Pure client-side, so NO epoch gate: the
//              clipboard never straddles a namespace. The async Clipboard API is
//              preferred, with the hidden-textarea + `execCommand('copy')` fallback
//              for browsers that have no permission-granted clipboard.
//   fork    <- `forkConversation` (:3680-3737). The selected index is INCLUSIVE,
//              so forking at a user message copies that turn and every earlier
//              one; the source record is never rewritten.
//   role    <- `switchMessage` + `switchMessageRole` (:1966-1980, :3603-3647).
//              Assistant -> user DROPS the storage-only model attribution (it is
//              assistant metadata, not message content); user -> assistant STAMPS
//              the currently selected model so the new turn carries the same
//              producing-model label a streamed reply would. System turns are
//              immutable through this control.
//   delete  <- `deleteMessage` (:3559-3601). A deletion shifts indices, so the
//              open inline edit is abandoned and the collapse set re-seeds.
//   update  <- `commitEdit` (:3818-3853). Blank text and unchanged text need no
//              request at all (empty messages are forbidden server-side, and the
//              keyed editor remount restores the persisted text).
//   turn    <- `toggleTurnCollapse` (:4272-4280). Pure view state, never a request.
//              -1 is the system-prompt DRAFT turn's sentinel, so it is accepted
//              here exactly as the sticky-gate bookkeeping accepted it.
//   focus   <- the composer's focus handoff (the oracle tracked `composerFocus`
//              for its split send control, :2629); the control's DOM owner reads
//              `chat.composer.focus` and calls it after a render.
//
// Guards, in oracle order, per flow. Every write goes through a namespace-pinned
// store captured BEFORE the first await, and every settle re-checks the epoch: a
// mode switch during a request leaves the edited history in the namespace that
// edited it (it survives a reload there) while touching nothing in the new one.
import { isString } from '@presource/core';
import type { DashboardPlugin } from '@underload/dashboard';
import type { ChatMessage, ConversationRecord } from '../../api/chat-assistant';
import {
    CHAT_AUTOSCROLL_TOGGLE_COMMAND,
    CHAT_ACTIVITY_SERVICE,
    CHAT_CELLS_SERVICE,
    CHAT_COMPOSER_FOCUS_COMMAND,
    CHAT_EPOCH_SERVICE,
    CHAT_ERROR_EVENT,
    CHAT_MESSAGE_COPY_COMMAND,
    CHAT_MESSAGE_DELETE_COMMAND,
    CHAT_MESSAGE_FORK_COMMAND,
    CHAT_MESSAGE_ROLE_COMMAND,
    CHAT_MESSAGE_UPDATE_COMMAND,
    CHAT_NOTICE_EVENT,
    CHAT_SESSION_SELECTED_EVENT,
    CHAT_SESSION_CREATED_EVENT,
    CHAT_TRANSCRIPT_UPDATED_EVENT,
    CHAT_TURN_TOGGLE_COMMAND,
    PLUGIN_IDS,
    type ChatActivity,
    type ChatCells,
    type ChatEpoch,
    type ChatGuard,
    type ChatMode,
    type ChatRole,
    type MessageRoleInput,
    type MessageUpdateInput,
    type NoticeEvent,
    type SessionCreatedEvent,
    type SessionSelectedEvent,
    type TranscriptUpdatedEvent
} from '../contract';
import {
    defaultCollapsedIndices,
    mergeSummary,
    summaryFromRecord
} from './core';
import { namespaceStore, readableFailure } from './source';
import { describeChatOptions, type ChatConfig, type ChatPluginOptions } from './options';

/**
 * Swap one turn's role with the oracle's reinterpretation rules
 * (`switchMessageRole`, components/ChatAssistantApp.tsx:1966-1980). System turns
 * are returned unchanged: the control is intentionally absent for them, and this
 * is the defensive guard for any other caller.
 */
export const switchMessageRole = (
    message: ChatMessage,
    role: ChatRole,
    assistantModel: string
): ChatMessage => {
    if (message.role === 'system' || role === 'system') return message;
    if (role === 'user') return { role: 'user', content: message.content };
    return {
        role: 'assistant',
        content: message.content,
        ...(assistantModel ? { model: assistantModel } : {})
    };
};

/** The composer input's testid, from the data-testid grammar in ../contract.ts. */
export const COMPOSER_INPUT_TESTID = 'composer-input';

export function createTranscriptPlugin(options: ChatPluginOptions = {}): DashboardPlugin {
    const config: ChatConfig = describeChatOptions(options);

    return {
        id: PLUGIN_IDS.chatTranscript,
        // Reads `chat.cells` + the epoch guard during setup.
        requires: [PLUGIN_IDS.chatCore],
        setup(api) {
            const cells = api.getService<ChatCells>(CHAT_CELLS_SERVICE);
            const epoch = api.getService<ChatEpoch>(CHAT_EPOCH_SERVICE);
            const activity = api.getService<ChatActivity>(CHAT_ACTIVITY_SERVICE);
            let alive = true;

            const storeFor = (mode: ChatMode) =>
                namespaceStore(config, mode, cells.providerBase.get());

            /** Write the banner + announce it (the shared failure surface). */
            const report = (reason: unknown): void => {
                const message = readableFailure(reason);
                cells.error.set(message);
                api.emit(CHAT_ERROR_EVENT, { message } satisfies NoticeEvent);
            };

            /**
             * Apply a canonical whole-history rewrite: the transcript, the collapse
             * defaults (the latest assistant index may have moved), the usage
             * aggregate, and the sidebar row â€” all from the canonical RECORD the
             * store returned, never from a reconstruction (its title and timestamps
             * are server-derived). The transcript half lands only on the surface
             * that still shows the edited conversation, the oracle's
             * `selected()?.conversationId === record.conversationId` guard
             * (:3633, :3777, :3841); the row is refreshed in the namespace that
             * performed the write so the edit stays discoverable.
             */
            const applyRewrite = (
                record: ConversationRecord,
                guard: ChatGuard
            ): void => {
                if (!alive || !epoch.namespaceCurrent(guard)) return;
                const frozen: readonly ChatMessage[] = Object.freeze([...record.messages]);
                if (
                    cells.activeSessionId.get() === record.conversationId &&
                    epoch.surfaceCurrent(guard)
                ) {
                    cells.transcript.set(frozen);
                    // A rewrite can shift indices (a deletion, a role swap that
                    // moves the latest assistant reply), so the collapse set
                    // re-seeds from the canonical record.
                    cells.collapsedTurns.set(defaultCollapsedIndices(frozen));
                    cells.editingIndex.set(null);
                    cells.usage.set(record.usage ?? null);
                }
                cells.sessions.set((previous) =>
                    mergeSummary(previous, summaryFromRecord(record))
                );
                cells.error.set('');
                const updated: TranscriptUpdatedEvent = {
                    sessionId: record.conversationId,
                    turnCount: frozen.length
                };
                api.emit(CHAT_TRANSCRIPT_UPDATED_EVENT, updated);
            };

            // â€”â€”â€” copy â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”
            // Resolves the turn's RAW text and hands it to the clipboard. Turn
            // index -1 is the system-prompt DRAFT turn, whose text lives in
            // `chat.systemDraft`, not in the transcript.
            const copyText = async (content: string): Promise<void> => {
                try {
                    if (navigator.clipboard?.writeText) {
                        await navigator.clipboard.writeText(content);
                    } else {
                        // Hidden-textarea fallback: jsdom and permission-restricted
                        // browsers have no clipboard, and older engines only honour
                        // the legacy command from within a user gesture.
                        const scratch = document.createElement('textarea');
                        scratch.value = content;
                        scratch.style.position = 'fixed';
                        scratch.style.opacity = '0';
                        document.body.appendChild(scratch);
                        scratch.select();
                        document.execCommand('copy');
                        document.body.removeChild(scratch);
                    }
                    if (alive) cells.error.set('');
                } catch (reason) {
                    if (alive) report(reason);
                }
            };

            api.command<number, void>(CHAT_MESSAGE_COPY_COMMAND, (index) => {
                const content =
                    index === -1
                        ? cells.systemDraft.get()
                        : cells.transcript.get()[index]?.content ?? '';
                // The clipboard call starts synchronously here, so a caller (and a
                // test) can observe it the moment the command returns.
                void copyText(content);
            });

            // â€”â€”â€” whole-history rewrites â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”
            /**
             * Shared body for role / delete / update: pin the namespace, PUT the
             * complete edited history, adopt the canonical record. The oracle ran
             * the same three steps with the same `savingEdit` guard
             * (:3569-3601, :3614-3647, :3818-3853).
             */
            const rewriteHistory = async (messages: ChatMessage[]): Promise<void> => {
                const sessionId = cells.activeSessionId.get();
                // A new-chat surface has no record to rewrite: the oracle returned
                // on `!record` (:3571, :3823).
                if (sessionId === null) return;
                if (activity.isBusy('saving')) return;
                const guard = epoch.capture();
                const mode: ChatMode = cells.mode.get() === 'offline' ? 'offline' : 'online';
                // Pinned BEFORE the first await: the rewrite always lands in the
                // namespace that asked for it.
                const store = storeFor(mode);
                activity.begin('saving');
                try {
                    const record = await store.replace(sessionId, { messages });
                    applyRewrite(record, guard);
                } catch (reason) {
                    if (alive && epoch.namespaceCurrent(guard)) report(reason);
                } finally {
                    // EPOCH-GATED RELEASE (the oracle gates every `finally` the same
                    // way: :3599 for the edit, :3787 for the rename). A mode switch
                    // calls `activity.reset()` for the NEW namespace, so the count this
                    // flow took is already gone; a stale `end()` there would decrement
                    // the count the new namespace just took and strand `chat.status` at
                    // 'idle' while a real save is still running.
                    if (alive && epoch.namespaceCurrent(guard)) activity.end('saving');
                }
            };

            api.command<MessageRoleInput, Promise<void>>(CHAT_MESSAGE_ROLE_COMMAND, (input) => {
                const index = input?.index ?? -1;
                const transcript = cells.transcript.get();
                const existing = transcript[index];
                // System turns (and out-of-range indices) are immutable here.
                if (!existing || existing.role === 'system') return Promise.resolve();
                const target = input?.role;
                if (target !== 'user' && target !== 'assistant') return Promise.resolve();
                // The swap is a no-op when the turn already carries the requested
                // role: no request, no re-render churn.
                if (existing.role === target) return Promise.resolve();
                if (activity.isBusy('saving')) return Promise.resolve();
                const next: ChatMessage[] = transcript.map((message, candidate) =>
                    candidate === index
                        ? switchMessageRole(message, target, cells.model.get())
                        : message
                );
                return rewriteHistory(next);
            });

            api.command<number, Promise<void>>(CHAT_MESSAGE_DELETE_COMMAND, (index) => {
                const transcript = cells.transcript.get();
                const target = transcript[index];
                // The cross never renders for a system turn, and an out-of-range
                // index has nothing to remove.
                if (!target || target.role === 'system') return Promise.resolve();
                if (activity.isBusy('saving')) return Promise.resolve();
                const next: ChatMessage[] = transcript.filter(
                    (_, candidate) => candidate !== index
                );
                return rewriteHistory(next);
            });

            api.command<MessageUpdateInput, Promise<void>>(CHAT_MESSAGE_UPDATE_COMMAND, (input) => {
                const index = input?.index ?? -1;
                const existing = cells.transcript.get()[index];
                if (!existing) return Promise.resolve();
                const text = isString(input?.content) ? input.content.trim() : '';
                // Blank closes WITHOUT persisting (empty messages are forbidden and
                // the keyed editor restores the persisted text), and unchanged text
                // needs no request at all â€” both guards of `commitEdit` (:3823-3824).
                if (!text || existing.content === text) {
                    if (alive) cells.editingIndex.set(null);
                    return Promise.resolve();
                }
                if (activity.isBusy('saving')) return Promise.resolve();
                const transcript = cells.transcript.get();
                // Only `content` is rewritten: the role and the producing-model
                // attribution of the edited turn are preserved (:3830-3832).
                const next: ChatMessage[] = transcript.map((message, candidate) =>
                    candidate === index ? { ...message, content: text } : message
                );
                // The editor closes synchronously, whatever the PUT does next: the
                // commit belongs to the surface that made it (:3822).
                cells.editingIndex.set(null);
                return rewriteHistory(next);
            });

            // â€”â€”â€” fork â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”
            api.command<number, Promise<string | null>>(CHAT_MESSAGE_FORK_COMMAND, async (index) => {
                if (!alive) return null;
                const sessionId = cells.activeSessionId.get();
                if (sessionId === null) return null;
                // A second create must not race the prompt-persist or another fork
                // (:3693 â€” the oracle's `deleting() || savingSystemPrompt()` guard).
                if (activity.isBusy('saving')) return null;
                const transcript = cells.transcript.get();
                const target = transcript[index];
                // Forking a system turn is meaningless: the leading block comes with
                // the prefix anyway (:3695).
                if (!target || target.role === 'system') return null;

                const guard = epoch.capture();
                const mode: ChatMode = cells.mode.get() === 'offline' ? 'offline' : 'online';
                const providerBase = cells.providerBase.get();
                // The fork's create + read-back both belong to the pinned namespace:
                // a mid-request switch must not lose the branch from the mode that
                // forked it (:3705-3712).
                const store = storeFor(mode);
                activity.begin('saving');
                try {
                    const prefix: ChatMessage[] = [...transcript.slice(0, index + 1)];
                    const row = cells.sessions.get().find(
                        (candidate) => candidate.conversationId === sessionId
                    );
                    // A FORK carries at least one user turn, so it never needs the
                    // model field defaulted away; the source row's model wins, with
                    // the live selection as the fallback (:3708-3711).
                    const forkRecord = await store.create({
                        messages: prefix,
                        model: row?.model || cells.model.get()
                    });
                    // No follow-up read: the store's `create` already answers with the
                    // canonical record (it performs the id-only POST, tracks the id, then
                    // reads the record back — services/conversations.ts:157-166), which is
                    // the oracle's `requestAssistantRecord` step done once, not twice.
                    if (!alive) return forkRecord.conversationId;
                    // A stale settle: the branch is persisted in its own namespace
                    // and shows up there on reload, but the other mode's sidebar and
                    // surface own themselves now (:3713-3716).
                    if (!epoch.namespaceCurrent(guard)) return forkRecord.conversationId;

                    // The new branch goes FIRST (it is the most recently created
                    // conversation), then becomes the active surface for
                    // continuation (:3717-3729).
                    const summary = summaryFromRecord(forkRecord);
                    cells.sessions.set((previous) => mergeSummary(previous, summary));
                    // The fork's recorded model is adopted and remembered (the
                    // oracle did both explicitly, :3722-3723).
                    cells.model.set(forkRecord.model);
                    const frozen: readonly ChatMessage[] = Object.freeze([
                        ...forkRecord.messages
                    ]);
                    cells.transcript.set(frozen);
                    cells.collapsedTurns.set(defaultCollapsedIndices(frozen));
                    cells.usage.set(forkRecord.usage ?? null);
                    cells.systemDraft.set('');
                    cells.editingSystem.set(false);
                    cells.editingIndex.set(null);
                    cells.autoscroll.set(true);
                    cells.drawerOpen.set(false);
                    cells.error.set('');
                    cells.activeSessionId.set(forkRecord.conversationId);

                    const createdEvent: SessionCreatedEvent = {
                        sessionId: summary.conversationId,
                        title: summary.title
                    };
                    api.emit(CHAT_SESSION_CREATED_EVENT, createdEvent);
                    const selected: SessionSelectedEvent = {
                        sessionId: forkRecord.conversationId
                    };
                    api.emit(CHAT_SESSION_SELECTED_EVENT, selected);
                    const updated: TranscriptUpdatedEvent = {
                        sessionId: forkRecord.conversationId,
                        turnCount: frozen.length
                    };
                    api.emit(CHAT_TRANSCRIPT_UPDATED_EVENT, updated);
                    const notice: NoticeEvent = {
                        message: `Forked ${frozen.length} messages into a new conversation.`
                    };
                    api.emit(CHAT_NOTICE_EVENT, notice);
                    return forkRecord.conversationId;
                } catch (reason) {
                    if (alive && epoch.namespaceCurrent(guard)) report(reason);
                    return null;
                } finally {
                    // EPOCH-GATED RELEASE, same rule as `rewriteHistory` above and the
                    // oracle's :3599/:3787 finallys: after `activity.reset()` the count
                    // this fork took belongs to the namespace that was left, and a stale
                    // end() would zero the new namespace's live save.
                    if (alive && epoch.namespaceCurrent(guard)) activity.end('saving');
                }
            });

            // â€”â€”â€” pure view-state commands â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”
            // Fold/unfold one turn. Immutable set, no request ever
            // (components/ChatAssistantApp.tsx:4272-4280). -1 is accepted because
            // that is the system-prompt DRAFT turn's sentinel.
            api.command<number, void>(CHAT_TURN_TOGGLE_COMMAND, (index) => {
                if (typeof index !== 'number' || Number.isNaN(index)) return;
                cells.collapsedTurns.set((previous) =>
                    Object.freeze(
                        previous.includes(index)
                            ? previous.filter((candidate) => candidate !== index)
                            : [...previous, index].sort((left, right) => left - right)
                    )
                );
            });

            api.command<void, boolean>(CHAT_AUTOSCROLL_TOGGLE_COMMAND, () => {
                const next = !cells.autoscroll.get();
                cells.autoscroll.set(next);
                return next;
            });

            // Focus the composer field. The command is issued by the control's own
            // DOM owner, so the node exists; jsdom and any non-browser host simply
            // find nothing and do nothing.
            api.command<void, void>(CHAT_COMPOSER_FOCUS_COMMAND, () => {
                if (typeof document === 'undefined') return;
                document
                    .querySelector<HTMLElement>(`[data-testid="${COMPOSER_INPUT_TESTID}"]`)
                    ?.focus({ preventScroll: true });
            });

            return () => {
                alive = false;
            };
        }
    };
}

/** The default-configured transcript plugin. */
export const transcriptPlugin: DashboardPlugin = createTranscriptPlugin();
