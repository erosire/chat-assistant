// MessageTurn: the rendered shape and the command payloads of ONE turn.
//
// Assertions are behavior-derived (what renders, what is dispatched, with which
// exact payload), taken from the pre-rebuild oracle's `renderMessages`
// (src/components/ChatAssistantApp.tsx:2007-2310) and its sticky gate (2401-2402).
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { CHAT_TURN_TOGGLE_COMMAND, type ChatTurn } from '../contract';
import { MessageTurn, controlsShouldFloat, nextRole, useStickyStrip } from './MessageTurn';
import { renderWithHarness } from './test-harness';

afterEach(() => {
    cleanup();
});

const LABELS: Record<string, string> = { 'vultr/coder': 'coder (vultr)' };
const labelFor = (id: string): string => LABELS[id] ?? id;

/** The scenario fields a test names; everything else is an inert default. */
type TurnScenario = {
    index: number;
    role: ChatTurn['role'];
    content: string;
    collapsed?: boolean;
    editing?: boolean;
    /** '' means "no recorded producing model" (user/system rows, old records). */
    model?: string;
};

/** Mount one turn inside a stand-in scroll container. */
function mount(turn: TurnScenario, props: Partial<ComponentProps<typeof MessageTurn>> = {}) {
    const model: ChatTurn = {
        index: turn.index,
        role: turn.role,
        collapsed: turn.collapsed ?? false,
        editing: turn.editing ?? false,
        model: turn.model ?? (turn.role === 'assistant' ? 'vultr/coder' : ''),
        message: {
            role: turn.role,
            content: turn.content,
            ...(turn.role === 'assistant' && (turn.model ?? 'vultr/coder') !== ''
                ? { model: turn.model ?? 'vultr/coder' }
                : {})
        }
    };
    const view = renderWithHarness(
        <ol data-testid="transcript">
            <MessageTurn turn={model} labelFor={labelFor} {...props} />
        </ol>
    );
    return view;
}

describe('turn shape by role', () => {
    it('renders the row, the role rail and the attribution label the oracle uses', () => {
        mount({ index: 0, role: 'user', content: 'hello there' });
        const row = screen.getByTestId('message-turn-0');
        expect(row.className).toBe('msg msg--user');
        // A user row is labelled with the literal speaker, never a model name.
        expect(screen.getByTestId('message-label-0').textContent).toBe('user');
        expect(screen.getByTestId('message-content-0').textContent).toBe('hello there');
        expect(screen.queryByTestId('message-model-0')).toBeNull();
    });

    it('attributes an assistant turn with the "base (provider)" display label', () => {
        mount({ index: 2, role: 'assistant', content: 'answer' });
        expect(screen.getByTestId('message-turn-2').className).toBe('msg msg--assistant');
        expect(screen.getByTestId('message-model-2').textContent).toBe('coder (vultr)');
    });

    it('falls back to the bare role for an assistant turn with no recorded model', () => {
        mount({ index: 1, role: 'assistant', content: 'old record', model: '' });
        expect(screen.getByTestId('message-label-1').textContent).toBe('assistant');
        expect(screen.queryByTestId('message-model-1')).toBeNull();
    });

    it('keeps the body as ONE plain text node (no markdown pipeline)', () => {
        mount({ index: 0, role: 'assistant', content: 'line one\nline **two**' });
        const body = screen.getByTestId('message-content-0');
        // The characters arrive verbatim: `**two**` is NOT converted, and the
        // newline survives as text (transcript.css renders it with pre-wrap).
        expect(body.childNodes).toHaveLength(1);
        expect(body.textContent).toBe('line one\nline **two**');
    });

    it('renders a system turn with neither a delete cross nor a role switch nor a fork', () => {
        mount({ index: 0, role: 'system', content: 'You are helpful.' });
        expect(screen.getByTestId('message-turn-0').className).toBe('msg msg--system');
        expect(screen.queryByTestId('delete-message-0')).toBeNull();
        expect(screen.queryByTestId('switch-message-0')).toBeNull();
        expect(screen.queryByTestId('fork-message-0')).toBeNull();
        // Copy still exists: a prompt is copyable, just not deletable.
        expect(screen.getByTestId('copy-message-0')).not.toBeNull();
    });
});

describe('collapse toggle (the attribution label IS the toggle)', () => {
    it('dispatches chat.turn.toggle with the row index and flips aria-expanded', () => {
        const view = mount({ index: 3, role: 'user', content: 'a question' });
        const toggle = screen.getByTestId('collapse-message-3');
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        fireEvent.click(toggle);
        expect(view.callsOf(CHAT_TURN_TOGGLE_COMMAND)).toEqual([3]);
    });

    it('collapses to the label plus a one-line first-line preview, hiding bubble and controls', () => {
        mount({ index: 1, role: 'assistant', content: 'first line\nsecond line', collapsed: true });
        expect(screen.getByTestId('message-turn-1').getAttribute('data-collapsed')).toBe('true');
        expect(screen.getByTestId('message-preview-1').textContent).toBe('first line');
        expect(screen.queryByTestId('message-content-1')).toBeNull();
        // A collapsed turn hides its copy/delete strip BY DESIGN (oracle 113-117),
        // while the role switch survives beside the label.
        expect(screen.queryByTestId('turn-controls-1')).toBeNull();
        expect(screen.getByTestId('switch-message-1')).not.toBeNull();
        // Collapsing hides the bubble AND its copy/delete affordances; the label
        // and the role switch are the only handles left.
        expect(screen.queryByTestId('delete-message-1')).toBeNull();
        expect(screen.queryByTestId('copy-message-1')).toBeNull();
    });

    it('expands again when the collapsed preview is clicked', () => {
        const view = mount({ index: 4, role: 'user', content: 'short one', collapsed: true });
        fireEvent.click(screen.getByTestId('message-preview-4'));
        expect(view.callsOf(CHAT_TURN_TOGGLE_COMMAND)).toEqual([4]);
    });
});

describe('trailing controls', () => {
    it('dispatches copy, fork, delete and the role switch with exact payloads', () => {
        const view = mount({ index: 5, role: 'assistant', content: 'reply' });
        expect(screen.getByTestId('turn-controls-5')).not.toBeNull();
        fireEvent.click(screen.getByTestId('copy-message-5'));
        fireEvent.click(screen.getByTestId('fork-message-5'));
        fireEvent.click(screen.getByTestId('switch-message-5'));
        fireEvent.click(screen.getByTestId('delete-message-5'));
        expect(view.callsOf('chat.message.copy')).toEqual([5]);
        expect(view.callsOf('chat.message.fork')).toEqual([5]);
        expect(view.callsOf('chat.message.role')).toEqual([{ index: 5, role: 'user' }]);
        expect(view.callsOf('chat.message.delete')).toEqual([5]);
    });

    it('switches a user turn to assistant (the oracle only swaps those two roles)', () => {
        expect(nextRole('user')).toBe('assistant');
        expect(nextRole('assistant')).toBe('user');
        const view = mount({ index: 0, role: 'user', content: 'q' });
        fireEvent.click(screen.getByTestId('switch-message-0'));
        expect(view.callsOf('chat.message.role')).toEqual([{ index: 0, role: 'assistant' }]);
    });

    it('greys every mutation control while another turn is being edited, without hiding them', () => {
        mount({ index: 2, role: 'user', content: 'q' }, { anyEditing: true });
        for (const id of ['switch-message-2', 'copy-message-2', 'fork-message-2', 'delete-message-2']) {
            const control = screen.getByTestId(id) as HTMLButtonElement;
            expect(control.disabled).toBe(true);
        }
        // The producing chrome STAYS RENDERED (oracle 68-77).
        expect(screen.getAllByRole('button').length).toBeGreaterThan(4);
    });

    it('hides the copy/fork strip and the delete cross while a save owns the record', () => {
        mount({ index: 6, role: 'user', content: 'q' }, { showControls: false });
        expect(screen.queryByTestId('turn-controls-6')).toBeNull();
        expect(screen.queryByTestId('delete-message-6')).toBeNull();
        // The header row and the bubble stay: only the mutation chrome is withdrawn.
        expect(screen.getByTestId('message-turn-6').firstElementChild?.textContent).toContain('user');
        expect(screen.getByTestId('message-content-6')).not.toBeNull();
    });
});

describe('section-local jump chevrons', () => {
    it('call the stage jump with this row\'s wrapper testid and direction', () => {
        const onJump = vi.fn();
        mount({ index: 7, role: 'assistant', content: 'reply' }, { onJump });
        fireEvent.click(screen.getByTestId('turn-jump-top-7'));
        fireEvent.click(screen.getByTestId('turn-jump-bottom-7'));
        expect(onJump.mock.calls).toEqual([
            ['message-turn-7', true],
            ['message-turn-7', false]
        ]);
    });

    it('renders no chevrons when the host has no scroll container to drive', () => {
        mount({ index: 0, role: 'user', content: 'q' });
        expect(screen.queryByTestId('turn-jump-top-0')).toBeNull();
        expect(screen.getByTestId('turn-controls-0')).not.toBeNull();
    });
});

describe('inline editing contract', () => {
    it('clicking an expanded bubble opens the editor through the host callback', () => {
        const onEditStart = vi.fn();
        mount({ index: 1, role: 'user', content: 'editable text' }, { onEditStart });
        fireEvent.click(screen.getByTestId('message-content-1'));
        // The offset is null here because jsdom cannot resolve a click point,
        // which is the documented "caret at the text end" case.
        expect(onEditStart.mock.calls).toEqual([[1, null]]);
    });

    it('renders the bubble itself as the contentEditable while edited', () => {
        mount({ index: 1, role: 'user', content: 'editable text', editing: true });
        const editor = screen.getByTestId('message-content-1');
        expect(editor.getAttribute('contenteditable')).toBe('true');
        expect(editor.getAttribute('aria-label')).toBe('Edit message');
        expect(editor.textContent).toBe('editable text');
        // The header survives an edit, but its toggle is inert (folding would
        // unmount the live editor).
        expect((screen.getByTestId('collapse-message-1') as HTMLButtonElement).disabled).toBe(true);
    });

    it('commits a blur-edited text through chat.message.update, then closes', () => {
        const onEditEnd = vi.fn();
        const view = mount({ index: 1, role: 'user', content: 'original', editing: true }, { onEditEnd });
        const editor = screen.getByTestId('message-content-1');
        editor.textContent = 'edited once';
        fireEvent.blur(editor);
        expect(view.callsOf('chat.message.update')).toEqual([{ index: 1, content: 'edited once' }]);
        expect(onEditEnd).toHaveBeenCalledTimes(1);
    });

    it('writes nothing when the blur delivered unchanged text', () => {
        const view = mount({ index: 1, role: 'assistant', content: 'same', editing: true });
        fireEvent.blur(screen.getByTestId('message-content-1'));
        expect(view.callsOf('chat.message.update')).toEqual([]);
    });

    it('cancels on Escape without writing, and the keyed remount restores the original text', () => {
        const onEditEnd = vi.fn();
        const view = mount({ index: 1, role: 'user', content: 'persisted text', editing: true }, { onEditEnd });
        const editor = screen.getByTestId('message-content-1');
        editor.textContent = 'half typed junk';
        fireEvent.keyDown(editor, { key: 'Escape' });
        expect(view.callsOf('chat.message.update')).toEqual([]);
        expect(onEditEnd).toHaveBeenCalledTimes(1);
        // React cannot revert a mutated contentEditable node, so the caller's
        // keyed remount is what restores the view bubble. Simulate the host
        // dropping the flag: the SAME testid is now a non-editable bubble whose
        // text is the persisted value again.
        cleanup();
        const restored = mount({ index: 1, role: 'user', content: 'persisted text', editing: false });
        const bubble = screen.getByTestId('message-content-1');
        expect(bubble.getAttribute('contenteditable')).toBeNull();
        expect(bubble.textContent).toBe('persisted text');
        expect(restored.callsOf('chat.message.update')).toEqual([]);
    });
});

describe('controlsShouldFloat (the pure sticky gate)', () => {
    // Geometry vocabulary: pinBottom is the list's bottom PADDING edge, and the
    // strip's natural slot is flush with the turn's bottom edge.
    it('stays anchored while the whole turn is still below the fold', () => {
        // Raw CSS sticky would clamp the strip onto the turn's TOP edge here and
        // cover its delete "x" - the exact bug the second clause prevents.
        // Turn [520, 1324], header [520, 542], pin line 400, strip 28.
        expect(controlsShouldFloat(1324, 542, 400, 28)).toBe(false);
    });

    it('floats once the turn end is past the pin line and the header is clear', () => {
        // Turn end 900 is below the pin (500); pin top = 500 - 28 = 472 sits at or
        // below the header's bottom (460), so the strip never covers the row above.
        expect(controlsShouldFloat(900, 460, 500, 28)).toBe(true);
    });

    it('stays anchored when the pinned position would cover the header row', () => {
        // Header bottom 480 is BELOW pin top 472: pinning would paint the strip
        // across the attribution label and its delete affordance.
        expect(controlsShouldFloat(900, 480, 500, 28)).toBe(false);
    });

    it('stays anchored when the turn end is inside the scrollport', () => {
        // 500.4 - 500 is within the 0.5px epsilon: sub-pixel geometry must not
        // flicker the mode on and off.
        expect(controlsShouldFloat(500.4, 300, 500, 28)).toBe(false);
        expect(controlsShouldFloat(501, 300, 500, 28)).toBe(true);
    });

    it('keeps the strip anchored in an environment with no measurable geometry', () => {
        // jsdom reports every rect as 0, so the gate must resolve deterministically
        // to "anchored" (the oracle documents the same behavior at 2977-2978).
        const turnRef = { current: document.createElement('li') };
        const stripRef = { current: document.createElement('div') };
        const rendered = renderWithHarness(
            <ol data-testid="transcript">
                <StickyProbe turnRef={turnRef} stripRef={stripRef} />
            </ol>
        );
        expect(screen.getByTestId('sticky-verdict').textContent).toBe('anchored');
        rendered.unmount();
    });
});

/** Reads the shared gate hook against refs owned by the test. */
function StickyProbe({
    turnRef,
    stripRef
}: {
    turnRef: { current: HTMLElement | null };
    stripRef: { current: HTMLElement | null };
}) {
    const floating = useStickyStrip(turnRef, stripRef);
    return <span data-testid="sticky-verdict">{floating ? 'floating' : 'anchored'}</span>;
}
