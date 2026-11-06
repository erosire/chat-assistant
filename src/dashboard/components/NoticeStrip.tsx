// NoticeStrip — the transient, non-error feedback row(s) under the transcript.
//
// WHAT IT SHOWS and what it never shows: rows come from the `chat.notices` feed that
// `chat.notices` (plugins/notices.ts) fills from `chat.notice` events — "Forked 4
// messages into a new conversation.", "System prompt saved.", the mode-switch
// consequence from `chat.mode.set`. FAILURES are not part of this surface: the last
// error lives in `chat.error` and the stage renders it as
// `[data-testid="error-banner"]` (ChatStage.tsx:320-324), so the two strips stay
// disjoint and one message never appears twice.
//
// WHY IT CAN RENDER NOTHING: an empty feed returns null, which is the whole
// "transient" contract — the station carries no persistent status chrome, and a
// surface that always occupied a row would steal height from the transcript inside
// the viewport-locked grid (styles/base.css:20-38).
//
// THE READ PATH: the feed is a SERVICE whose value is state-shaped
// (`ChatNoticeFeed = DashboardState<readonly ChatNotice[]>`, see contract.ts), so the
// component subscribes with `useDashboardState(instance.service(...))` and re-renders
// on a push. A plain `instance.service(...).get()` without the subscription would
// show a stale strip until some unrelated cell changed.
//
// DISMISSAL: one row leaves through its own control, the whole strip leaves through
// the group control; both run `chat.notice.dismiss`, which also clears the surfaced
// error (the "cleared by dismissal" half of the notice rule).
import {
    CHAT_NOTICE_DISMISS_COMMAND,
    CHAT_NOTICES_SERVICE,
    type ChatNotice,
    type ChatNoticeFeed
} from '../contract';
import { useDashboardService, useDashboardState } from '../state-hooks';
import { useWorkbench } from '../workbench';
import { CloseIcon } from '../../icons';

/** The three tones a feed row may carry; `info` is what the event channel produces. */
const TONES = ['info', 'success', 'warn'] as const;

export function NoticeStrip() {
    const instance = useWorkbench();
    const notices = useDashboardService<ChatNoticeFeed>(CHAT_NOTICES_SERVICE);
    const rows = useDashboardState<readonly ChatNotice[]>(notices);

    if (rows.length === 0) return null;

    return (
        <div className="notice" data-testid="notice-strip" role="status">
            {/* One row per notice, oldest first (the feed appends newest last, so the
                strip reads like the log above it). `data-tone` — not a class — is what
                notices.css colours: `info` neutral, `success` accent, `warn` amber. */}
            {rows.map((row) => (
                <div
                    className="notice__row"
                    key={row.id}
                    data-tone={TONES.includes(row.tone) ? row.tone : 'info'}
                    data-testid={`notice-row-${row.id}`}
                >
                    <span className="notice__text">{row.message}</span>
                    <button
                        type="button"
                        className="notice__dismiss"
                        aria-label="Dismiss notice"
                        title="Dismiss notice"
                        data-testid={`notice-dismiss-${row.id}`}
                        onClick={() =>
                            instance.execute<number, number>(CHAT_NOTICE_DISMISS_COMMAND, row.id)
                        }
                    >
                        <CloseIcon size={12} />
                    </button>
                </div>
            ))}

            {/* No input = clear the whole strip, and the surfaced error with it. Only
                offered once there is something to clear. */}
            <button
                type="button"
                className="notice__clear btn btn--ghost"
                aria-label="Dismiss all notices"
                title="Dismiss all notices"
                data-testid="notice-clear"
                onClick={() => instance.execute<void, number>(CHAT_NOTICE_DISMISS_COMMAND)}
            >
                Dismiss all
            </button>
        </div>
    );
}
