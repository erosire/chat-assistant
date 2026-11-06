// ChatStage: the scroll contract of the one scrolling surface.
//
// The rules under test come from the oracle's follow effect and edge-jump flight
// (src/components/ChatAssistantApp.tsx:2912-2958 and 3046-3132). The pure halves
// (`shouldPinBottom`, `jumpEdgeTarget`) are asserted with exact numbers; the DOM
// half drives the real list element with stubbed geometry, which is how the
// oracle's own suite tests the same behaviour (jsdom has no layout, so a rect is
// whatever the test says it is — and a section's rect MUST track `scrollTop`,
// because the flight re-measures on arrival).
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    CHAT_ACTIVE_SESSION_STATE,
    CHAT_AUTOSCROLL_STATE,
    CHAT_DRAFT_STATE,
    CHAT_ERROR_STATE,
    CHAT_PENDING_STATE,
    CHAT_STREAMING_STATE,
    CHAT_TURNS_STATE,
    type ChatPendingTurn,
    type ChatTurn
} from '../contract';
import { ChatStage, JUMP_SCROLL_DURATION, jumpEdgeTarget, shouldPinBottom } from './ChatStage';
import { makeTurn, renderWithHarness, type HarnessSeed } from './test-harness';

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

const SEED: HarnessSeed = {
    models: ['vultr/coder'],
    providerCatalog: ['vultr/coder'],
    providerLabels: ['coder (vultr)'],
    model: 'vultr/coder'
};

/** The previous dep tuple `shouldPinBottom` classifies against. */
const snapshot = (over: Partial<{ draft: string; pending: string; streaming: string; sessionId: string | null; turnCount: number }> = {}) => ({
    draft: '',
    pending: '',
    streaming: '',
    sessionId: 'a',
    turnCount: 1,
    ...over
});

describe('shouldPinBottom (the follow gate, pure)', () => {
    it('pins the very first commit so a freshly opened chat lands on its latest turn', () => {
        expect(shouldPinBottom(null, snapshot(), false, true, false)).toBe(true);
    });

    it('treats a session pick, typing, a send and a surface reset as explicit signals', () => {
        // Every one of these pins even with the list scrolled up and the follow
        // switch off: they are the user's own actions on THIS surface.
        expect(shouldPinBottom(snapshot({ sessionId: 'a' }), snapshot({ sessionId: 'b' }), false, true, false)).toBe(
            true
        );
        expect(shouldPinBottom(snapshot({ draft: '' }), snapshot({ draft: 'typed' }), false, false, false)).toBe(true);
        expect(
            shouldPinBottom(snapshot({ pending: '' }), snapshot({ pending: 'sent now' }), false, false, false)
        ).toBe(true);
        expect(
            shouldPinBottom(snapshot({ sessionId: 'a' }), snapshot({ sessionId: null }), false, false, false)
        ).toBe(true);
    });

    it('lets ambient refreshes (streamed tokens, a swapped record) pin ONLY at the bottom edge', () => {
        // A mid-stream jump away therefore STICKS instead of being yanked back.
        expect(shouldPinBottom(snapshot(), snapshot({ streaming: 'partial' }), false, true, false)).toBe(false);
        expect(shouldPinBottom(snapshot(), snapshot({ turnCount: 2 }), false, true, false)).toBe(false);
        // The follow silently resumes once the operator returns to the bottom.
        expect(shouldPinBottom(snapshot(), snapshot({ streaming: 'partial' }), true, true, false)).toBe(true);
    });

    it('never writes scrollTop while an edge-jump flight owns it', () => {
        expect(shouldPinBottom(snapshot(), snapshot({ streaming: 'partial' }), true, true, true)).toBe(false);
        expect(shouldPinBottom(null, snapshot(), true, true, true)).toBe(false);
    });

    it('honours the follow switch for ambient signals, never for explicit ones', () => {
        expect(shouldPinBottom(snapshot(), snapshot({ streaming: 'more' }), true, false, false)).toBe(false);
        expect(shouldPinBottom(snapshot(), snapshot({ draft: 'typing' }), true, false, false)).toBe(true);
    });
});

describe('jumpEdgeTarget (the section docking math, pure)', () => {
    const base = { scrollTop: 120, maxScroll: 900, listTop: 200, listHeight: 400 };

    it('docks a section top on the list top padding line', () => {
        // 120 + (640 - 200) - 8 paddingTop.
        expect(jumpEdgeTarget({ ...base, edge: 640, padding: 8, toTop: true })).toBe(552);
    });

    it('lands a section bottom on the list bottom padding line', () => {
        // 120 + (900 - 200) + 8 paddingBottom - 400 clientHeight.
        expect(jumpEdgeTarget({ ...base, edge: 900, padding: 8, toTop: false })).toBe(428);
    });

    it('clamps to the real travel range in both directions', () => {
        expect(jumpEdgeTarget({ ...base, scrollTop: 0, edge: 100, padding: 0, toTop: true })).toBe(0);
        expect(jumpEdgeTarget({ ...base, edge: 99999, padding: 0, toTop: true })).toBe(900);
        expect(jumpEdgeTarget({ ...base, scrollTop: 0, maxScroll: 0, edge: 0, padding: 0, toTop: false })).toBe(0);
    });
});

/** Make the scroll port report a real travel range with a readable scrollTop. */
function stubScroll(
    element: HTMLElement,
    input: { scrollTop: number; scrollHeight: number; clientHeight: number }
) {
    let scrollTop = input.scrollTop;
    Object.defineProperty(element, 'scrollTop', {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
            scrollTop = value;
        }
    });
    Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => input.scrollHeight });
    Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => input.clientHeight });
    return {
        atTop: () => scrollTop,
        scrolled: (value: number) => {
            scrollTop = value;
        }
    };
}

/** A scroll port whose own rect never moves (only its content does). */
function stubListRect(list: HTMLElement, top: number, height: number) {
    list.getBoundingClientRect = () =>
        ({
            x: 0,
            y: top,
            width: 600,
            height,
            top,
            right: 600,
            bottom: top + height,
            left: 0,
            toJSON: () => ({})
        }) as DOMRect;
}

/**
 * A section's rect in SCROLL-CONTENT coordinates: its viewport position tracks
 * `list.scrollTop`, which is what makes the flight's live re-measure at arrival
 * land on the docked edge instead of overshooting.
 */
function stubContentRect(section: HTMLElement, list: HTMLElement, content: { top: number; bottom: number }) {
    section.getBoundingClientRect = () => {
        const top = content.top - list.scrollTop;
        const bottom = content.bottom - list.scrollTop;
        return {
            x: 0,
            y: top,
            width: 600,
            height: bottom - top,
            top,
            right: 600,
            bottom,
            left: 0,
            toJSON: () => ({})
        } as DOMRect;
    };
}

/** Fake rAF with monotonic handles, so a cancel is assertable. */
function stubFrames() {
    const frames: FrameRequestCallback[] = [];
    const cancels: number[] = [];
    let handle = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
        frames.push(cb);
        handle += 1;
        return handle;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
        cancels.push(id);
    });
    /** Pump frames 100ms apart: the fixed 200ms budget completes in three. */
    const pump = (count: number) => {
        let now = 0;
        act(() => {
            for (let index = 0; index < count && frames.length > 0; index += 1) {
                const frame = frames.shift() as FrameRequestCallback;
                frame(now);
                now += 100;
            }
        });
    };
    return { frames, cancels, pump };
}

describe('the stage surface', () => {
    it('renders the transcript list, the composer, and no error strip while clean', () => {
        renderWithHarness(<ChatStage />, { ...SEED, turns: [makeTurn(0, 'user', 'question')] });
        expect(screen.getByTestId('transcript')).not.toBeNull();
        expect(screen.getByTestId('composer')).not.toBeNull();
        expect(screen.getByTestId('message-turn-0')).not.toBeNull();
        expect(screen.queryByTestId('error-banner')).toBeNull();
    });

    it('shows the non-modal error strip below the log when chat.error is set', () => {
        const view = renderWithHarness(<ChatStage />, SEED);
        act(() => view.write<string>(CHAT_ERROR_STATE, 'Provider stream failed'));
        expect(screen.getByTestId('error-banner').textContent).toBe('Provider stream failed');
        act(() => view.write<string>(CHAT_ERROR_STATE, ''));
        expect(screen.queryByTestId('error-banner')).toBeNull();
    });
});

describe('bottom following, on the real element', () => {
    it('pins to the bottom edge as content grows while the list sits at its end', () => {
        const view = renderWithHarness(<ChatStage />, { ...SEED, turns: [makeTurn(0, 'user', 'question')] });
        const list = screen.getByTestId('transcript');
        stubScroll(list, { scrollTop: 500, scrollHeight: 900, clientHeight: 400 });
        // 500 + 400 >= 900 - 1, so the scroll listener marks the list "at bottom".
        fireEvent.scroll(list);
        expect(view.read<boolean>(CHAT_AUTOSCROLL_STATE)).toBe(true);

        act(() => view.write<string>(CHAT_STREAMING_STATE, 'partial answer'));
        expect(list.scrollTop).toBe(900);

        act(() =>
            view.write<readonly ChatTurn[]>(CHAT_TURNS_STATE, [
                makeTurn(0, 'user', 'question'),
                makeTurn(1, 'assistant', 'answer')
            ])
        );
        expect(list.scrollTop).toBe(900);
    });

    it('does not fight the reader: a scrolled-up list ignores streamed tokens and record refreshes', async () => {
        const view = renderWithHarness(<ChatStage />, { ...SEED, turns: [makeTurn(0, 'user', 'question')] });
        const list = screen.getByTestId('transcript');
        stubScroll(list, { scrollTop: 0, scrollHeight: 900, clientHeight: 400 });
        // The reader scrolled away: the follow switch flips off with the edge truth.
        fireEvent.scroll(list);
        await waitFor(() => expect(view.read<boolean>(CHAT_AUTOSCROLL_STATE)).toBe(false));

        act(() => view.write<string>(CHAT_STREAMING_STATE, 'a token arrives'));
        expect(list.scrollTop).toBe(0);
        act(() =>
            view.write<readonly ChatTurn[]>(CHAT_TURNS_STATE, [
                makeTurn(0, 'user', 'question'),
                makeTurn(1, 'assistant', 'done')
            ])
        );
        expect(list.scrollTop).toBe(0);
        // The ambient writes never toggled the follow switch a second time.
        expect(view.callsOf('chat.autoscroll.toggle')).toHaveLength(1);
    });

    it('still re-pins on the explicit signals: a send and a session pick', async () => {
        const view = renderWithHarness(<ChatStage />, {
            ...SEED,
            turns: [makeTurn(0, 'user', 'question')],
            activeSessionId: 'a'
        });
        const list = screen.getByTestId('transcript');
        stubScroll(list, { scrollTop: 40, scrollHeight: 900, clientHeight: 400 });
        fireEvent.scroll(list);
        await waitFor(() => expect(view.read<boolean>(CHAT_AUTOSCROLL_STATE)).toBe(false));

        // SEND: the pending bubble appearing is an explicit signal.
        act(() => view.write<ChatPendingTurn>(CHAT_PENDING_STATE, { text: 'next question', at: 1767225600000 }));
        expect(list.scrollTop).toBe(900);
        // The explicit pin re-armed the edge truth, so the follow switch is back on.
        expect(view.read<boolean>(CHAT_AUTOSCROLL_STATE)).toBe(true);

        // SESSION PICK: an opened chat lands on its latest turn from anywhere.
        stubScroll(list, { scrollTop: 12, scrollHeight: 1400, clientHeight: 400 });
        act(() => view.write<string | null>(CHAT_ACTIVE_SESSION_STATE, 'b'));
        expect(list.scrollTop).toBe(1400);
    });

    it('treats composer typing as explicit, so the growing field never hides the caret', async () => {
        const view = renderWithHarness(<ChatStage />, { ...SEED, turns: [makeTurn(0, 'user', 'question')] });
        const list = screen.getByTestId('transcript');
        stubScroll(list, { scrollTop: 5, scrollHeight: 900, clientHeight: 400 });
        fireEvent.scroll(list);
        await waitFor(() => expect(view.read<boolean>(CHAT_AUTOSCROLL_STATE)).toBe(false));
        act(() => view.write<string>(CHAT_DRAFT_STATE, 'typ...'));
        expect(list.scrollTop).toBe(900);
    });
});

describe('section-local edge jumps from the turn chevrons', () => {
    it('flies the list until this turn\'s top edge docks on the top padding line', () => {
        const { pump } = stubFrames();
        const view = renderWithHarness(<ChatStage />, {
            ...SEED,
            turns: [makeTurn(0, 'user', 'question'), makeTurn(1, 'assistant', 'answer')]
        });
        const list = screen.getByTestId('transcript');
        stubScroll(list, { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 });
        stubListRect(list, 200, 400);
        // Turn 1 lives at content [800, 940]: below the fold, so the up chevron has
        // real travel (0 -> 600, the clamp of maxScroll 600).
        stubContentRect(screen.getByTestId('message-turn-1'), list, { top: 800, bottom: 940 });
        expect(JUMP_SCROLL_DURATION).toBe(200);

        fireEvent.click(screen.getByTestId('turn-jump-top-1'));
        pump(3);
        expect(list.scrollTop).toBe(600);
        // The jump is pure scroll: no command was ever executed for it.
        expect([...view.calls.keys()]).toEqual([]);
    });

    it('flies the list until this turn\'s bottom edge lands on the bottom padding line', () => {
        const { pump } = stubFrames();
        renderWithHarness(<ChatStage />, { ...SEED, turns: [makeTurn(0, 'user', 'question')] });
        const list = screen.getByTestId('transcript');
        stubScroll(list, { scrollTop: 100, scrollHeight: 1000, clientHeight: 400 });
        stubListRect(list, 100, 400);
        // content [700, 800]: 100 + (800 - 100) - 100 - 400 = 300, and at scrollTop
        // 300 the bottom edge sits exactly on the list's bottom edge (500).
        stubContentRect(screen.getByTestId('message-turn-0'), list, { top: 700, bottom: 800 });

        fireEvent.click(screen.getByTestId('turn-jump-bottom-0'));
        pump(3);
        expect(list.scrollTop).toBe(300);
        // Re-measured live at arrival, not from the stale start-time target.
        pump(1);
        expect(list.scrollTop).toBe(300);
    });

    it('cancels the in-flight frame before retargeting a second click', () => {
        const { frames, cancels, pump } = stubFrames();
        renderWithHarness(<ChatStage />, { ...SEED, turns: [makeTurn(0, 'user', 'question')] });
        const list = screen.getByTestId('transcript');
        stubScroll(list, { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 });
        stubListRect(list, 100, 400);
        stubContentRect(screen.getByTestId('message-turn-0'), list, { top: 700, bottom: 800 });

        fireEvent.click(screen.getByTestId('turn-jump-top-0'));
        // Only the first frame has run, so the flight still owns a live handle.
        pump(1);
        expect(frames).toHaveLength(1);
        fireEvent.click(screen.getByTestId('turn-jump-bottom-0'));
        // The retarget cancels the SECOND handle (the frame the first pump
        // re-scheduled), never the already-run one.
        expect(cancels).toEqual([2]);
    });

    it('jumps instantly when the section is already docked (zero travel)', () => {
        const { frames, pump } = stubFrames();
        renderWithHarness(<ChatStage />, { ...SEED, turns: [makeTurn(0, 'user', 'question')] });
        const list = screen.getByTestId('transcript');
        stubScroll(list, { scrollTop: 300, scrollHeight: 1000, clientHeight: 400 });
        stubListRect(list, 100, 400);
        // content top 400 is already on the top padding line: 300 + (400 - 300) - 100
        // == 300, so the click takes the zero-travel branch and schedules nothing.
        stubContentRect(screen.getByTestId('message-turn-0'), list, { top: 400, bottom: 500 });
        fireEvent.click(screen.getByTestId('turn-jump-top-0'));
        expect(frames).toHaveLength(0);
        expect(list.scrollTop).toBe(300);
        pump(1);
        expect(list.scrollTop).toBe(300);
    });
});
