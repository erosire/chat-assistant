// ChatStage — the stage column's owner: the ONE scroll container, the error
// strip slot, and the composer.
//
// BEHAVIOR ORACLE (read-only): src/components/ChatAssistantApp.tsx
//   - the bottom-follow effect            2912-2958 (pin + its two carve-outs)
//   - the list-edge truth refresh         2979-3014 (`listAtBottom` half of
//                                          syncStickyControls)
//   - the edge-jump flight                3046-3132 (`jumpTurnEdge`: fixed 200ms
//                                          ease-out cubic on the rAF clock alone,
//                                          re-measured live at arrival)
//   - the jump/padding measurement        3066-3082
//   - the error strip                     5075 (`{error() && <ErrorBanner/>}`)
//
 // WHY THE SCROLL CONTAINER IS OWNED HERE: the transcript list is the station's
// only scrolling surface for the conversation (base.css makes `.station__region`
// the outer one, and this column sizes itself to it). ChatStage holds the ref that
// TranscriptStream puts on `[data-testid="transcript"]`, so exactly one component
// writes `scrollTop` — the follow effect, the jump flights, and every turn's
// sticky gate all read the same element. Two owners was the oracle's original bug
// family ("^ never reaches the top / random jumps to the bottom").
import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import {
    CHAT_ACTIVE_SESSION_STATE,
    CHAT_AUTOSCROLL_STATE,
    CHAT_AUTOSCROLL_TOGGLE_COMMAND,
    CHAT_DRAFT_STATE,
    CHAT_ERROR_STATE,
    CHAT_PENDING_STATE,
    CHAT_STATUS_STATE,
    CHAT_STREAMING_STATE,
    CHAT_TRANSCRIPT_STATE,
    CHAT_TURNS_STATE,
    type ChatStatus,
    type ChatTurn
} from '../contract';
import { useDashboardValue } from '../state-hooks';
import { useWorkbench } from '../workbench';
import { ComposerDeck } from './ComposerDeck';
import { TranscriptStream } from './TranscriptStream';

// Fixed animation budget (ms) for an edge jump: "fast" per the control's contract
// means a FIXED duration rather than distance-proportional scrolling, so a
// 500-turn chat reaches its far edge exactly as quickly as a 5-turn one (2379-2382).
export const JUMP_SCROLL_DURATION = 200;

// Edge tolerance for the bottom-truth gate: `scrollTop + clientHeight` within 1px
// of `scrollHeight` already counts as "at the bottom". Fractional scroll geometry
// and the browser's own clamping must not detach the token follow one subpixel
// above the edge (2373-2377).
export const LIST_EDGE_EPSILON = 1;

/** The in-flight user text cell: `chat.pending` (null = nothing in flight). */
type PendingValue = { text: string; at: number } | null;

/** Inputs of one edge-jump target measurement, all read live from the scroll port. */
export type JumpEdgeInput = {
    scrollTop: number;
    maxScroll: number;
    /** The section's edge in VIEWPORT coordinates (top when `toTop`, else bottom). */
    edge: number;
    listTop: number;
    listHeight: number;
    /** The list's padding on the side being docked to. */
    padding: number;
    toTop: boolean;
};

/**
 * Pure edge-jump target math, extracted from the oracle's `measureTarget` closure
 * (ChatAssistantApp.tsx:3073-3082) so the two directions and both clamps are
 * testable without a real scroll port. Rects are viewport-live, so
 * `edge - listTop + scrollTop` converts them into scroll-content coordinates, and
 * the list's own padding re-centres the section's edge ON the padding line (a
 * docked section sits exactly where normal flow content starts). The target
 * clamps to the real travel range `[0, maxScroll]`.
 */
export const jumpEdgeTarget = (input: JumpEdgeInput): number => {
    const { scrollTop, maxScroll, edge, listTop, listHeight, padding, toTop } = input;
    const raw = toTop
        ? scrollTop + edge - listTop - padding
        : scrollTop + edge - listTop + padding - listHeight;
    return Math.min(maxScroll, Math.max(0, raw));
};

/** The dep tuple the follow effect classifies triggers against. */
export type FollowSnapshot = {
    draft: string;
    pending: string;
    streaming: string;
    sessionId: string | null;
    turnCount: number;
};

/**
 * Pure trigger classification for the bottom-follow effect, exported so it is
 * testable without a real scroll port. The oracle's rules (2932-2937):
 *
 *   EXPLICIT signals — first commit, a session pick, composer typing, a send (the
 *   pending bubble appearing) and a surface reset — pin UNCONDITIONALLY.
 *   AMBIENT signals — streamed tokens and same-surface record refreshes — pin only
 *   while the follow switch is on AND the list is already at its bottom edge, so a
 *   mid-stream jump away STICKS instead of being yanked back down.
 *
 * `jumping` is carve-out 1: while an edge-jump flight owns `scrollTop`, NOTHING
 * else may write it.
 */
export const isExplicitFollowSignal = (
    previous: FollowSnapshot | null,
    current: FollowSnapshot
): boolean => {
    if (previous === null) return true;
    const picked = previous.sessionId !== current.sessionId;
    const typed = previous.draft !== current.draft;
    const sent = previous.pending === '' && current.pending !== '';
    const reset = previous.sessionId !== null && current.sessionId === null;
    return picked || typed || sent || reset;
};

export const shouldPinBottom = (
    previous: FollowSnapshot | null,
    current: FollowSnapshot,
    atBottom: boolean,
    autoscroll: boolean,
    jumping: boolean
): boolean => {
    // Carve-out 1: while an edge-jump flight owns scrollTop, nothing else writes it.
    if (jumping) return false;
    // Explicit user signals pin from anywhere, whatever the follow switch says.
    if (isExplicitFollowSignal(previous, current)) return true;
    // Ambient signals (streamed tokens, a swapped record) pin ONLY while the
    // follow switch is on AND the list already sits at its bottom edge, so a
    // mid-stream jump away STICKS instead of being yanked back down.
    return autoscroll && atBottom;
};

export function ChatStage() {
    const instance = useWorkbench();

    // ——— state ————————————————————————————————————————————————————————————
    const turns = useDashboardValue<readonly ChatTurn[]>(CHAT_TURNS_STATE);
    const transcript = useDashboardValue<readonly unknown[]>(CHAT_TRANSCRIPT_STATE);
    const draft = useDashboardValue<string>(CHAT_DRAFT_STATE);
    const pending = useDashboardValue<PendingValue>(CHAT_PENDING_STATE);
    const streaming = useDashboardValue<string>(CHAT_STREAMING_STATE);
    const sessionId = useDashboardValue<string | null>(CHAT_ACTIVE_SESSION_STATE);
    const autoscroll = useDashboardValue<boolean>(CHAT_AUTOSCROLL_STATE);
    const status = useDashboardValue<ChatStatus>(CHAT_STATUS_STATE);
    const error = useDashboardValue<string>(CHAT_ERROR_STATE);

    // ——— refs (write-without-render, stable for the effect cleanups) ————————
    // The scroll container itself: TranscriptStream renders the element, this
    // component drives it.
    const listRef = useRef<HTMLOListElement | null>(null);
    // rAF handle of an in-flight edge jump. A ref, not state: a flight must not
    // re-render the stage, and the identity must stay stable across renders or the
    // cleanup would cancel the animation mid-flight (the oracle's
    // "^ goes partially, second click completes" glitch, 3120-3132).
    const jumpRef = useRef<number | null>(null);
    // Bottom-edge truth, refreshed by the scroll listener and read at commit time.
    // A ref on purpose: a state write here would re-render the stage on every
    // scroll event (the oracle keeps it in a cell because its follow effect reads
    // accessor state; the truth is identical).
    const atBottomRef = useRef(true);
    // Previous dep tuple, for the trigger classification.
    const followRef = useRef<FollowSnapshot | null>(null);

    const pendingText = pending === null ? '' : pending.text;

    // ——— bottom truth + the follow switch mirror ————————————————————————————
    // One scroll listener does both jobs the oracle split across
    // `syncStickyControls`: refresh `atBottomRef`, and keep `chat.autoscroll`
    // telling the truth about where the operator is reading. Programmatic jump
    // frames are skipped — a flight is not user intent, and an up-chevron would
    // otherwise switch the follow off on the way up.
    useEffect(() => {
        const list = listRef.current;
        if (list === null) return;
        const track = () => {
            const atBottom =
                list.scrollTop + list.clientHeight >= list.scrollHeight - LIST_EDGE_EPSILON;
            atBottomRef.current = atBottom;
            if (jumpRef.current === null && atBottom !== autoscroll) {
                instance.execute<void, boolean>(CHAT_AUTOSCROLL_TOGGLE_COMMAND);
            }
        };
        list.addEventListener('scroll', track, { passive: true });
        track();
        return () => list.removeEventListener('scroll', track);
    }, [autoscroll, instance]);

    // ——— the bottom-follow effect ———————————————————————————————————————————
    // Runs after every commit touching the conversation surface. The classification
    // is exported (`shouldPinBottom`) so the trigger families are pinned by unit
    // tests rather than by scroll geometry jsdom cannot produce.
    useEffect(() => {
        const list = listRef.current;
        const current: FollowSnapshot = {
            draft,
            pending: pendingText,
            streaming,
            sessionId,
            turnCount: transcript.length
        };
        const previous = followRef.current;
        // The snapshot rewrites on EVERY run — skipped pins included — so the
        // classification never goes stale (oracle 2938-2949).
        followRef.current = current;
        if (list === null) return;
        const explicit = isExplicitFollowSignal(previous, current);
        if (!shouldPinBottom(previous, current, atBottomRef.current, autoscroll, jumpRef.current !== null)) return;
        list.scrollTop = list.scrollHeight;
        atBottomRef.current = true;
        // An explicit signal that lands the list on its bottom edge RE-ARMS the
        // follow switch: the operator just asked for an answer, so the tokens that
        // follow are wanted (the oracle's "the follow silently resumes once the
        // user returns to the bottom", surfaced through the one cell that owns it).
        if (explicit && !autoscroll) {
            instance.execute<void, boolean>(CHAT_AUTOSCROLL_TOGGLE_COMMAND);
        }
    }, [draft, pendingText, streaming, transcript, turns, sessionId, autoscroll, instance]);

    // ——— section-local edge jump ————————————————————————————————————————————
    /**
     * Fly the list so the addressed section's edge docks on the list's
     * corresponding padding line. `testId` addresses the wrapper
     * (`message-turn-N`, `system-prompt-turn`) exactly like the oracle, because
     * each strip scrolls the page's only scrollbar relative to ITS OWN block
     * (3046-3064). Rects are viewport-live, so `edge - listTop + scrollTop`
     * converts to scroll-content coordinates and the list's own padding re-centres
     * the edge on the padding line.
     */
    const jumpTurnEdge = useCallback((testId: string, toTop: boolean) => {
        const list = listRef.current;
        const turn = list?.querySelector<HTMLElement>(`[data-testid="${testId}"]`) ?? null;
        if (list === null || turn === null) return;

        // A fresh click cancels the in-flight flight before retargeting.
        if (jumpRef.current !== null) cancelAnimationFrame(jumpRef.current);

        // Measured LIVE on every arrival, not once: an inlined editor or a
        // reflowing neighbour can move a section's far edge DURING the 200ms
        // flight, and a compute-once target would then land short of the edge.
        const measureTarget = (): number => {
            const listRect = list.getBoundingClientRect();
            const style = window.getComputedStyle(list);
            return jumpEdgeTarget({
                scrollTop: list.scrollTop,
                maxScroll: Math.max(0, list.scrollHeight - list.clientHeight),
                edge: toTop ? turn.getBoundingClientRect().top : turn.getBoundingClientRect().bottom,
                listTop: listRect.top,
                listHeight: list.clientHeight,
                padding: Number.parseFloat(toTop ? style.paddingTop : style.paddingBottom) || 0,
                toTop
            });
        };

        const startTop = list.scrollTop;
        const targetTop = measureTarget();
        // Environments without rAF (and zero-travel clicks) jump INSTANTLY.
        if (targetTop === startTop || typeof requestAnimationFrame !== 'function') {
            list.scrollTop = targetTop;
            jumpRef.current = null;
            atBottomRef.current =
                list.scrollTop + list.clientHeight >= list.scrollHeight - LIST_EDGE_EPSILON;
            return;
        }

        const distance = targetTop - startTop;
        // CLOCK DISCIPLINE (3092-3100): the flight is measured on the rAF timeline
        // ALONE — the first frame's own timestamp is t0. Mixing Node's
        // performance clock with the rAF callback's `now` made progress hugely
        // negative in jsdom and the list "jumped" to scrollTop -78900. The [0,1]
        // clamp on BOTH ends is the second belt: a frame can never overshoot.
        let startTime: number | undefined;
        const step = (now: number) => {
            if (startTime === undefined) startTime = now;
            const progress = Math.min(Math.max((now - startTime) / JUMP_SCROLL_DURATION, 0), 1);
            // Ease-out cubic: 1 - (1 - p)^3 — fast launch, soft landing.
            list.scrollTop = startTop + distance * (1 - Math.pow(1 - progress, 3));
            if (progress < 1) {
                jumpRef.current = requestAnimationFrame(step);
                return;
            }
            list.scrollTop = measureTarget();
            jumpRef.current = null;
            atBottomRef.current =
                list.scrollTop + list.clientHeight >= list.scrollHeight - LIST_EDGE_EPSILON;
        };
        jumpRef.current = requestAnimationFrame(step);
    }, []);

    // Never let a pending jump frame write to a detached list on unmount. The
    // cleanup deps are empty because `jumpRef` is a create-once ref.
    useEffect(
        () => () => {
            if (jumpRef.current !== null) cancelAnimationFrame(jumpRef.current);
            jumpRef.current = null;
        },
        []
    );

    // Deletion and prompt persistence own a changing record, so the turn chrome
    // disappears for the duration (the oracle's `showControls = !deleting() &&
    // !savingSystemPrompt()`, 4405). Provider waiting/streaming deliberately does
    // NOT: generation must never make the dashboard look frozen.
    const showControls = status !== 'saving';

    return (
        <div className="stage" data-status={status} data-testid="stage">
            <TranscriptStream
                listRef={listRef as RefObject<HTMLOListElement>}
                onJumpTurnEdge={jumpTurnEdge}
                showControls={showControls}
            />

            {/* The error strip sits BELOW the log and ABOVE the composer, exactly
                like the oracle's (5075): an actionable failure never covers the
                transcript and never blocks typing the retry. */}
            {error !== '' ? (
                <p className="stage__error" role="status" data-testid="error-banner">
                    {error}
                </p>
            ) : null}

            <ComposerDeck />
        </div>
    );
}
