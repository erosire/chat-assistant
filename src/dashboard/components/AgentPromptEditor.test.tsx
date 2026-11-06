// AgentPromptEditor: the field, the grip's accessible contract, and the resize math.
//
// The oracle's behaviour is a PIXEL height driven by pointer geometry, and jsdom has
// no layout engine: `getBoundingClientRect()` and `clientHeight` are both 0. The
// component treats a zero measurement as "the field is at its floor"
// (AgentPromptEditor.tsx:26-31), which is what makes the drag and the keyboard step
// assertable as EXACT pixel values here: floor 96, step 24, cap 480.
//
// The height lands on the node's inline style (the one inline style the skin allows),
// so the assertions read `element.style.height` rather than any CSS file.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
    AGENT_PROMPT_MAX_HEIGHT,
    AGENT_PROMPT_MIN_HEIGHT,
    AGENT_PROMPT_RESIZE_STEP,
    AgentPromptEditor,
    clampPromptHeight,
    promptHeightFrom
} from './AgentPromptEditor';

afterEach(() => {
    cleanup();
});

/** Mount the editor the way AgentWorkspace does, with the oracle's own props. */
function mountEditor(overrides: { value?: string } = {}) {
    const changes: string[] = [];
    const view = render(
        <AgentPromptEditor
            value={overrides.value ?? 'You are a scout.'}
            placeholder="System prompt the agent uses in chat..."
            aria-label="Agent system prompt"
            rows={10}
            data-testid="agent-prompt-input"
            onChange={(event) => changes.push(event.target.value)}
        />
    );
    const field = screen.getByTestId('agent-prompt-input') as HTMLTextAreaElement;
    const grip = screen.getByTestId('agent-prompt-grip');
    return { ...view, field, grip, changes };
}

/** The field's current inline height, or '' when nothing has been applied yet. */
const appliedHeight = (field: HTMLTextAreaElement): string => field.style.height;

describe('the composed field', () => {
    it('wraps the textarea in the grip\'s positioning context and forwards every prop', () => {
        const { field, grip } = mountEditor();
        const wrapper = field.parentElement as HTMLElement;
        expect(wrapper.className).toBe('agent__prompt');
        expect(wrapper.contains(grip)).toBe(true);
        // The textarea keeps the oracle's identity and props: same testid, same
        // accessible name, same placeholder, same row count, and the native grip off.
        expect(field.getAttribute('aria-label')).toBe('Agent system prompt');
        expect(field.getAttribute('placeholder')).toBe('System prompt the agent uses in chat...');
        expect(field.getAttribute('rows')).toBe('10');
        expect(field.getAttribute('class')).toBe('agent__prompt-input');
        expect(appliedHeight(field)).toBe('');
    });

    it('appends a caller class instead of replacing the field\'s own', () => {
        render(<AgentPromptEditor className="extra" data-testid="agent-prompt-input" readOnly />);
        expect(screen.getByTestId('agent-prompt-input').getAttribute('class')).toBe(
            'agent__prompt-input extra'
        );
    });

    it('names the grip the way the oracle does, and keeps it focusable', () => {
        const { grip } = mountEditor();
        expect(grip.getAttribute('role')).toBe('separator');
        expect(grip.getAttribute('aria-orientation')).toBe('horizontal');
        expect(grip.getAttribute('aria-label')).toBe('Resize the system prompt field');
        expect(grip.getAttribute('title')).toBe('Drag to resize');
        expect(grip.getAttribute('tabindex')).toBe('0');
        // An idle grip is inert; the drag flag drives its opacity (agents.css).
        expect(grip.getAttribute('data-resizing')).toBe('false');
    });

    it('hands typed text straight to the caller', () => {
        const { field, changes } = mountEditor();
        fireEvent.change(field, { target: { value: 'You are a planner.' } });
        expect(changes).toEqual(['You are a planner.']);
    });
});

describe('keyboard resize', () => {
    it('grows one step per ArrowDown from the floor, and shrinks per ArrowUp', () => {
        const { field, grip } = mountEditor();

        fireEvent.keyDown(grip, { key: 'ArrowDown' });
        expect(appliedHeight(field)).toBe(`${AGENT_PROMPT_MIN_HEIGHT + AGENT_PROMPT_RESIZE_STEP}px`);
        expect(appliedHeight(field)).toBe('120px');

        fireEvent.keyDown(grip, { key: 'ArrowDown' });
        expect(appliedHeight(field)).toBe('144px');

        fireEvent.keyDown(grip, { key: 'ArrowUp' });
        expect(appliedHeight(field)).toBe('120px');
    });

    it('clamps at the floor and never below it', () => {
        const { field, grip } = mountEditor();
        fireEvent.keyDown(grip, { key: 'ArrowDown' });
        fireEvent.keyDown(grip, { key: 'ArrowUp' });
        fireEvent.keyDown(grip, { key: 'ArrowUp' });
        expect(appliedHeight(field)).toBe('96px');
    });

    it('clamps at the cap after enough presses to overshoot it', () => {
        const { field, grip } = mountEditor();
        // 96 + 24*20 = 576, and every frame past 480 is written as exactly 480.
        for (let press = 0; press < 20; press += 1) {
            fireEvent.keyDown(grip, { key: 'ArrowDown' });
        }
        expect(appliedHeight(field)).toBe('480px');
        // The remembered height is capped too, so further presses stay put instead of
        // drifting inside an over-long remembered value.
        fireEvent.keyDown(grip, { key: 'ArrowDown' });
        expect(appliedHeight(field)).toBe('480px');
    });

    it('leaves every other key to the field', () => {
        const { field, grip } = mountEditor();
        fireEvent.keyDown(grip, { key: 'Enter' });
        fireEvent.keyDown(grip, { key: 'ArrowRight' });
        expect(appliedHeight(field)).toBe('');
    });
});

describe('pointer drag', () => {
    it('applies the vertical delta from the grab point and tracks the drag flag', () => {
        const { field, grip } = mountEditor();

        fireEvent.pointerDown(grip, { clientY: 100 });
        expect(grip.getAttribute('data-resizing')).toBe('true');

        // jsdom measures 0, so the gesture starts at the 96px floor: +60 -> 156.
        fireEvent.pointerMove(window, { clientY: 160 });
        expect(appliedHeight(field)).toBe('156px');

        fireEvent.pointerMove(window, { clientY: 40 });
        expect(appliedHeight(field)).toBe('96px');

        fireEvent.pointerUp(window);
        expect(grip.getAttribute('data-resizing')).toBe('false');
    });

    it('keeps listening while the pointer leaves the 4px grip, and stops at pointerup', () => {
        const { field, grip } = mountEditor();
        fireEvent.pointerDown(grip, { clientY: 0 });
        fireEvent.pointerMove(window, { clientY: 200 });
        const dragged = appliedHeight(field);
        expect(dragged).toBe('296px');

        fireEvent.pointerUp(window);
        // A stray move after the release must not move the field any more: the
        // window listeners belong to the gesture, not to the component's lifetime.
        fireEvent.pointerMove(window, { clientY: 900 });
        expect(appliedHeight(field)).toBe(dragged);
    });

    it('treats pointercancel as the end of the gesture', () => {
        const { field, grip } = mountEditor();
        fireEvent.pointerDown(grip, { clientY: 0 });
        fireEvent.pointerMove(window, { clientY: 120 });
        fireEvent.pointerCancel(window);
        expect(grip.getAttribute('data-resizing')).toBe('false');

        fireEvent.pointerMove(window, { clientY: 500 });
        expect(appliedHeight(field)).toBe('216px');
    });

    it('removes its listeners on unmount, so a late frame cannot write a detached node', () => {
        const { field, grip } = mountEditor();
        fireEvent.pointerDown(grip, { clientY: 0 });
        cleanup();
        // The node is gone from the document; a move must neither throw nor resurrect it.
        expect(() => fireEvent.pointerMove(window, { clientY: 300 })).not.toThrow();
        expect(document.contains(field)).toBe(false);
    });
});

describe('the height helpers', () => {
    it('clamps a candidate height to the documented range', () => {
        expect(AGENT_PROMPT_MIN_HEIGHT).toBe(96);
        expect(AGENT_PROMPT_MAX_HEIGHT).toBe(480);
        expect(AGENT_PROMPT_RESIZE_STEP).toBe(24);
        expect(clampPromptHeight(10)).toBe(96);
        expect(clampPromptHeight(96)).toBe(96);
        expect(clampPromptHeight(200)).toBe(200);
        expect(clampPromptHeight(480)).toBe(480);
        expect(clampPromptHeight(900)).toBe(480);
    });

    it('prefers the remembered height, then the measured box, then the floor', () => {
        expect(promptHeightFrom(null, 150)).toBe(150);
        expect(promptHeightFrom(null, null)).toBe(96);
        // A real measurement wins over the absent memory, and a zero-height box
        // (jsdom) degrades to the floor rather than to 0.
        const box = { getBoundingClientRect: () => ({ height: 240 }), clientHeight: 240 } as unknown as HTMLTextAreaElement;
        expect(promptHeightFrom(box, null)).toBe(240);
        const flat = { getBoundingClientRect: () => ({ height: 0 }), clientHeight: 0 } as unknown as HTMLTextAreaElement;
        expect(promptHeightFrom(flat, null)).toBe(96);
        // A remembered 0 is a real drag result, not a missing measurement.
        expect(promptHeightFrom(flat, 0)).toBe(0);
    });
});
