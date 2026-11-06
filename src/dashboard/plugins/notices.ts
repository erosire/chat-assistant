// NOTICES plugin: everything the two feedback strips show, in one place.
//
// TWO SURFACES, ONE OWNER (and neither is rendered here):
//   `chat.error`  the LAST failure, kept until a successful action or a dismissal.
//                 Rendered by the stage as `[data-testid="error-banner"]`
//                 (components/ChatStage.tsx:320-324) — this plugin deliberately owns
//                 NO error-banner testid, because the stage already owns it.
//   `chat.notices` the transient notice rows, rendered by NoticeStrip as
//                 `[data-testid="notice-strip"]`. A SERVICE, not a state cell: every
//                 `chat.*` state id belongs to the chat core (plugins/core.ts), so the
//                 feed is published as `chat.notices` with a state-shaped handle
//                 (`DashboardState<readonly ChatNotice[]>`) and a view subscribes to it
//                 with `useDashboardState` exactly as it would for a cell.
//
// WHY A SUBSCRIBER AT ALL, when the emitting plugins already write the cell: they do
// both (write `chat.error` AND emit `chat.error`), so this file is the single place
// the two channels are reconciled rather than a second opinion — the cell write makes
// the value land for a view that mounts later (events are live-only, contract.ts:519),
// and the subscription makes a failure that was ONLY announced (an add-on plugin, or
// a future emitter) still reach the banner. Re-applying the same text is a
// SameValueZero no-op (packages/underload/dashboard/src/types/index.ts:19-28), so
// neither path double-writes and the strip never re-renders on a repeat.
//
// THE CLEAR RULES, ported from the oracle's banner discipline
// (components/ChatAssistantApp.tsx:5075 renders it, every flow clears it):
//   1. a failure KEEPS its text — nothing here clears on a successful listing or a
//      background refresh (plugins/sessions.ts:143-147 documents exactly that trap);
//   2. a SUCCESSFUL ACTION clears it: the terminal events of a stream that produced a
//      reply, and a transcript that was just rewritten by a real flow;
//   3. DISMISSAL clears it: `chat.notice.dismiss` is the control's seam for the strip
//      AND the banner, so one acknowledge gesture takes both off the screen;
//   4. a namespace switch clears it (plugins/core.ts:548 already does that part).
//
// NO REACT, NO JSX, NO DOM.
import type { DashboardPlugin } from '@underload/dashboard';
import {
    CHAT_CELLS_SERVICE,
    CHAT_ERROR_EVENT,
    CHAT_NOTICE_DISMISS_COMMAND,
    CHAT_NOTICE_EVENT,
    CHAT_NOTICES_SERVICE,
    CHAT_STREAM_COMPLETED_EVENT,
    CHAT_TRANSCRIPT_UPDATED_EVENT,
    PLUGIN_IDS,
    type ChatCells,
    type ChatNotice,
    type ChatNoticeFeed,
    type ChatNoticeTone,
    type NoticeEvent,
    type StreamCompletedEvent,
    type TranscriptUpdatedEvent
} from '../contract';

/** The empty feed, frozen so an equal clear compares identical every time. */
const NO_NOTICES: readonly ChatNotice[] = Object.freeze([]);

/**
 * Rows the strip keeps. Three is the number the eye can read at once in the aside's
 * width, and the cap is what makes an unattended flow (a poller failing on a loop)
 * able to fill the panel without burying the operator.
 */
export const MAX_NOTICE_ROWS = 3;

/**
 * A minimal observable, structurally identical to the framework's own cells
 * (`get` / `set` / `subscribe`, immutable writes, SameValueZero change detection) —
 * the contract's `ChatNoticeFeed` IS `DashboardState<readonly ChatNotice[]>`, which is
 * what lets a view bind to it through `useDashboardState` (state-hooks.ts:36-39) with
 * no second bridge.
 *
 * It is a local cell rather than `api.state()` because the state id space is global
 * and every `chat.*` id is the chat core's reservation; publishing this handle as a
 * SERVICE is the one seam that keeps the plugin from claiming a `chat.*` cell.
 */
export const createNoticeFeed = (
    initial: readonly ChatNotice[] = NO_NOTICES
): ChatNoticeFeed => {
    let value = initial;
    const listeners = new Set<() => void>();
    return {
        get: (): readonly ChatNotice[] => value,
        set: (
            next: readonly ChatNotice[] | ((previous: readonly ChatNotice[]) => readonly ChatNotice[])
        ): void => {
            const resolved = typeof next === 'function'
                ? (next as (previous: readonly ChatNotice[]) => readonly ChatNotice[])(value)
                : next;
            // Equal writes notify nobody — the framework's own rule, copied so a
            // re-push of the same row list cannot loop `useSyncExternalStore`.
            if (resolved === value) return;
            value = resolved;
            // Snapshot first: a listener may unsubscribe during the pass, and Set
            // iteration would otherwise skip its neighbour.
            for (const listener of [...listeners]) listener();
        },
        subscribe: (listener: () => void): (() => void) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        }
    };
};

export type NoticesPluginOptions = {
    /** Row cap (default `MAX_NOTICE_ROWS`); the oldest row is the one dropped. */
    maxRows?: number;
};

export function createNoticesPlugin(options: NoticesPluginOptions = {}): DashboardPlugin {
    const maxRows = options.maxRows && options.maxRows > 0 ? options.maxRows : MAX_NOTICE_ROWS;

    return {
        id: PLUGIN_IDS.chatNotices,
        // `chat.error` is reached through the core's cell handle (there is no state
        // reader in the plugin API), so the edge is mandatory, not decorative.
        requires: [PLUGIN_IDS.chatCore],
        setup(api) {
            const cells = api.getService<ChatCells>(CHAT_CELLS_SERVICE);
            const feed = createNoticeFeed();
            api.service<ChatNoticeFeed>(CHAT_NOTICES_SERVICE, feed);

            let alive = true;
            // Monotonic row id: stable for the React key, and the dismiss input. A
            // counter rather than `Date.now()` because two rows emitted in the same
            // millisecond must still be individually addressable.
            let sequence = 0;

            /**
             * Append one row and cap the strip. Event-driven rows are 'info'; a plugin
             * that owns the feed service may push a 'success'/'warn' row directly
             * (NoticeStrip.tsx styles all three tones), because the handle is a writable
             * `DashboardState`.
             */
            const push = (message: string, tone: ChatNoticeTone = 'info'): void => {
                const text = (message ?? '').trim();
                if (!text) return;
                sequence += 1;
                const row: ChatNotice = Object.freeze({
                    id: sequence,
                    message: text,
                    tone,
                    at: Date.now()
                });
                feed.set((previous) => {
                    const rows = [...previous, row];
                    // Newest last, oldest dropped: the strip reads bottom-up like a log.
                    return Object.freeze(rows.slice(Math.max(0, rows.length - maxRows)));
                });
            };

            // ——— the two feedback channels ——————————————————————————————————————
            // `chat.error` -> the banner. Kept verbatim (no tone, no trim of meaning):
            // the emitter already produced a display-ready message, and the oracle's
            // banner prints exactly this string (ChatAssistantApp.tsx:5075).
            const onError = api.on<NoticeEvent>(CHAT_ERROR_EVENT, (payload) => {
                if (!alive) return;
                const text = (payload?.message ?? '').trim();
                if (!text) return;
                cells.error.set(text);
            });

            // `chat.notice` -> the strip. Errors never enter the strip: they own the
            // banner, so the two surfaces stay disjoint and one message is never shown
            // twice (the rule in styles/notices.css's header).
            const onNotice = api.on<NoticeEvent>(CHAT_NOTICE_EVENT, (payload) => {
                if (!alive) return;
                push(payload?.message ?? '');
            });

            // ——— the "cleared by a successful action" half of the rule ——————————————
            // A reply that completed is the strongest success a chat flow can report
            // (plugins/source.ts:674-679 emits it only on the non-aborted, persisted
            // path), and a transcript rewrite is what a successful select / fork /
            // prompt save announces (plugins/transcript.ts:371, plugins/sessions.ts:237).
            const onCompleted = api.on<StreamCompletedEvent>(
                CHAT_STREAM_COMPLETED_EVENT,
                (): void => {
                    if (alive) cells.error.set('');
                }
            );
            const onTranscriptUpdated = api.on<TranscriptUpdatedEvent>(
                CHAT_TRANSCRIPT_UPDATED_EVENT,
                (): void => {
                    if (alive) cells.error.set('');
                }
            );

            // A mode switch is a namespace switch: the rows describe the mode being
            // left, and the core clears the banner there (plugins/core.ts:548). Reached
            // through a cell subscription — state is truth, and this plugin must not
            // depend on which command moved the cell.
            const onModeChange = cells.mode.subscribe((): void => {
                if (!alive) return;
                feed.set(NO_NOTICES);
            });
            // A provider-base edit keeps the strip: the notice still describes the
            // configuration the operator is editing, and the offline hint above the
            // input is the surface that changes, not this one.

            // ——— `chat.notice.dismiss` ———————————————————————————————————————————
            // One gesture acknowledges the feedback: the addressed row (or every row)
            // leaves the strip, and the surfaced failure leaves the banner. Returns the
            // rows still on screen so a control can decide whether to keep focus.
            api.command<number | void, number>(CHAT_NOTICE_DISMISS_COMMAND, (id) => {
                if (id === undefined || id === null) feed.set(NO_NOTICES);
                else feed.set((previous) => Object.freeze(previous.filter((row) => row.id !== id)));
                if (alive) cells.error.set('');
                return feed.get().length;
            });

            return () => {
                // `alive` FIRST: every handler and subscription below writes a cell, and
                // a write to a detached cell throws 'disposed'. The framework drops the
                // event subscriptions with the instance, and the feed's own listeners
                // die with the unmounting view, so only the handles are ours to close.
                alive = false;
                onError();
                onNotice();
                onCompleted();
                onTranscriptUpdated();
                onModeChange();
            };
        }
    };
}

/** The default-configured notices plugin. */
export const noticesPlugin: DashboardPlugin = createNoticesPlugin();
