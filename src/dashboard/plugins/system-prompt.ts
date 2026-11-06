// Chat SYSTEM-PROMPT plugin: the leading system turn and its draft.
//
// THE MODEL (ported from `startSystemPromptEdit` / `saveSystemPromptDraft` /
// `cancelSystemPromptDraft`, components/ChatAssistantApp.tsx:3202-3298):
//
//   A chat's opening system prompt has TWO representations, and exactly one is
//   live at a time:
//     - a PERSISTED leading system message (`chat.transcript[0].role === 'system'`),
//       rendered as a normal turn and editable through chat.message.update;
//     - a LOCAL DRAFT (`chat.systemDraft`), rendered as the draft turn at the TOP
//       of the list whenever the transcript has no leading system message. While
//       empty that turn shows the placeholder "no prompt"; a non-empty blur commit
//       is persisted immediately by chat.system.save.
//   The draft turn's identity is the index -1 SENTINEL — the same sentinel the
//   oracle used in its sticky/collapsed bookkeeping (:2541-2545, :3004-3007), so
//   `chat.collapsedTurns` may contain -1 and `chat.turn.toggle(-1)` folds the draft
//   turn. `chat.editingSystem` is the draft turn's own inline-editor flag; the
//   persisted turns use `chat.editingIndex` instead, and the two are never set at
//   the same time.
//
//   Persistence splits on whether a record already exists: an existing conversation
//   prepends the prompt with a whole-history PUT (an append could only attach it at
//   the END, and the leading block must stay at index 0), while a new-chat surface
//   creates a record of its OWN through POST `systemPrompt` — otherwise leaving the
//   page before the first user send loses the edit (:3243-3258).
//
//   The draft text, its editor and the collapse set are cleared on new chat, on
//   session switch and after a completed send; those resets live with the flows
//   that own them (plugins/sessions.ts, plugins/source.ts), not here.
import type { DashboardPlugin } from '@underload/dashboard';
import type { ChatMessage } from '../../api/chat-assistant';
import {
    CHAT_ACTIVITY_SERVICE,
    CHAT_CELLS_SERVICE,
    CHAT_EPOCH_SERVICE,
    CHAT_ERROR_EVENT,
    CHAT_NOTICE_EVENT,
    CHAT_SESSION_CREATED_EVENT,
    CHAT_SYSTEM_BEGIN_COMMAND,
    CHAT_SYSTEM_CANCEL_COMMAND,
    CHAT_SYSTEM_SAVE_COMMAND,
    CHAT_TRANSCRIPT_UPDATED_EVENT,
    PLUGIN_IDS,
    type ChatActivity,
    type ChatCells,
    type ChatEpoch,
    type ChatMode,
    type NoticeEvent,
    type SessionCreatedEvent,
    type TranscriptUpdatedEvent
} from '../contract';
import {
    defaultCollapsedIndices,
    mergeSummary,
    summaryFromRecord
} from './core';
import { namespaceStore, readableFailure } from './source';
import { describeChatOptions, type ChatConfig, type ChatPluginOptions } from './options';

export function createSystemPromptPlugin(options: ChatPluginOptions = {}): DashboardPlugin {
    const config: ChatConfig = describeChatOptions(options);

    return {
        id: PLUGIN_IDS.chatSystemPrompt,
        // Reads `chat.cells` + the epoch guard during setup.
        requires: [PLUGIN_IDS.chatCore],
        setup(api) {
            const cells = api.getService<ChatCells>(CHAT_CELLS_SERVICE);
            const epoch = api.getService<ChatEpoch>(CHAT_EPOCH_SERVICE);
            const activity = api.getService<ChatActivity>(CHAT_ACTIVITY_SERVICE);
            let alive = true;

            const storeFor = (mode: ChatMode) =>
                namespaceStore(config, mode, cells.providerBase.get());

            /**
             * Commit the draft bubble's delivered text.
             *
             * The order below is the oracle's and it is load-bearing
             * (components/ChatAssistantApp.tsx:3223-3297): the editor flag closes
             * FIRST (a save that fails still leaves the operator out of the editor
             * with their text visible for a retry), the trimmed draft is written
             * next so a failed persist keeps it, and only then does the persist
             * branch run. A blank commit clears the draft and issues NO request
             * (the storage layer rejects an empty system message).
             */
            const saveSystemPrompt = async (): Promise<void> => {
                if (!alive) return;
                const text = cells.systemDraft.get().trim();
                const sessionId = cells.activeSessionId.get();
                cells.editingSystem.set(false);
                cells.systemDraft.set(text);
                if (!text) return;
                // The prompt PUT/create owns the conversation until it settles: a
                // second edit or a send must not race it and overwrite the history
                // the prompt is being prepended to (:3230, and the matching
                // `savingSystemPrompt()` guard in the send pipeline).
                if (activity.isBusy('saving')) return;

                // EPOCH GUARD: the persist belongs to the namespace at COMMIT time.
                // A switch during the save moves the surface to the other namespace;
                // the write still lands in the captured one, but its response
                // applies nothing — record, sidebar row, banner and draft — to the
                // new mode (:3232-3239).
                const guard = epoch.capture();
                const mode: ChatMode = cells.mode.get() === 'offline' ? 'offline' : 'online';
                const store = storeFor(mode);
                activity.begin('saving');
                try {
                    let record;
                    if (sessionId !== null) {
                        // The draft only renders while the record has NO leading
                        // system message, so prepending is safe and leaves the rest
                        // of the history untouched.
                        const history: ChatMessage[] = [
                            { role: 'system', content: text },
                            ...cells.transcript.get()
                        ];
                        record = await store.replace(sessionId, { messages: history });
                    } else {
                        // A new-chat prompt must have a record of its own in the
                        // active namespace, otherwise leaving the page before the
                        // first user send loses the edit. The model is only sent
                        // when one is selected (a blank model would fail the
                        // store's own validation, api/offline.ts:314-328).
                        const model = cells.model.get();
                        record = await store.create(
                            model
                                ? { model, systemPrompt: text }
                                : { systemPrompt: text }
                        );
                    }
                    if (!alive) return;
                    if (!epoch.namespaceCurrent(guard)) return;

                    const frozen: readonly ChatMessage[] = Object.freeze([...record.messages]);
                    const summary = summaryFromRecord(record);
                    // The write can land after New chat or another chat pick, so the
                    // record applies only while the surface that committed the text
                    // still owns it — the oracle's `sameSurface` (:3265-3270): the id
                    // it started on, AND a draft that still carries the committed text
                    // (a newer edit owns the bubble now).
                    const sameSurface =
                        cells.activeSessionId.get() === sessionId &&
                        cells.systemDraft.get() === text;
                    if (sameSurface) {
                        // Same surface: adopt the canonical record, and the draft is
                        // now persisted, so it and its editor clear — the system turn
                        // returns to the persisted message's chrome (:3271-3275).
                        cells.transcript.set(frozen);
                        cells.collapsedTurns.set(defaultCollapsedIndices(frozen));
                        cells.usage.set(record.usage ?? null);
                        cells.systemDraft.set('');
                        cells.editingIndex.set(null);
                        if (sessionId === null) {
                            // A prompt-created conversation BECOMES the open surface:
                            // the oracle's `selected(result)` on the no-record branch
                            // (:3272), since it did not exist when the operator started
                            // typing. Written last, because adopting a new id is itself
                            // a surface switch.
                            cells.activeSessionId.set(record.conversationId);
                        }
                    }
                    // The sidebar row follows the write regardless of which surface
                    // is open, so the server write stays discoverable after the
                    // operator navigates away (:3277-3281).
                    cells.sessions.set((previous) => mergeSummary(previous, summary));
                    cells.error.set('');

                    const created: SessionCreatedEvent = {
                        sessionId: summary.conversationId,
                        title: summary.title
                    };
                    api.emit(CHAT_SESSION_CREATED_EVENT, created);
                    const updated: TranscriptUpdatedEvent = {
                        sessionId: record.conversationId,
                        turnCount: frozen.length
                    };
                    api.emit(CHAT_TRANSCRIPT_UPDATED_EVENT, updated);
                    const notice: NoticeEvent = { message: 'System prompt saved.' };
                    api.emit(CHAT_NOTICE_EVENT, notice);
                } catch (reason) {
                    // A switch during the persist: the new namespace's banner must
                    // not receive the stale failure. Otherwise keep the typed prompt
                    // visible for retry, but never overwrite a different surface's
                    // state after navigation (:3283-3292).
                    if (alive && epoch.namespaceCurrent(guard)) {
                        const message = readableFailure(reason);
                        cells.error.set(message);
                        api.emit(CHAT_ERROR_EVENT, { message } satisfies NoticeEvent);
                    }
                } finally {
                    // The mode switch owns the busy flag for the new namespace; a
                    // stale settle must not clear (or re-take) it there (:3293-3297).
                    // `reset()` already dropped this flow's count, so an unguarded
                    // `end()` here would zero a count the new namespace just took and
                    // leave `chat.status` at 'idle' during a live save.
                    if (alive && epoch.namespaceCurrent(guard)) activity.end('saving');
                }
            };

            api.command<void, void>(CHAT_SYSTEM_BEGIN_COMMAND, () => {
                // Open the draft editor. There is NO textarea: the bubble IS the
                // contentEditable, its text lives in the DOM until blur commits it
                // into `chat.systemDraft` (or Escape cancels), exactly as the
                // oracle's keyed remount worked (:2525-2530).
                cells.editingSystem.set(true);
            });

            api.command<void, Promise<void>>(CHAT_SYSTEM_SAVE_COMMAND, () => saveSystemPrompt());

            api.command<void, void>(CHAT_SYSTEM_CANCEL_COMMAND, () => {
                // Abandon the EDITOR only. The saved draft text is untouched — the
                // keyed bubble remount reverts any half-typed DOM text on its own
                // (:3202-3207).
                cells.editingSystem.set(false);
            });

            return () => {
                alive = false;
            };
        }
    };
}

/** The default-configured system-prompt plugin. */
export const systemPromptPlugin: DashboardPlugin = createSystemPromptPlugin();
