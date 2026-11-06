// ComposerDeck: the keyboard rules, the height contract, and the command payloads.
//
// Every expectation is derived from the pre-rebuild oracle
// (src/components/ChatAssistantApp.tsx): the Enter/Shift+Enter/IME gate
// (5179-5192 + the header rule at 123-126), the border-box autogrow math
// (2421-2439), the focus-gated send arrow (5081-5090, 5222-5241), the always
// visible mic (5205-5221) and the `Total tokens: N` line (5169-5171).
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentDefinition } from '../../agents';
import {
    CHAT_AGENT_SET_COMMAND,
    CHAT_AUTOSCROLL_STATE,
    CHAT_DRAFT_SET_COMMAND,
    CHAT_DRAFT_STATE,
    CHAT_LISTENING_STATE,
    CHAT_MESSAGE_CANCEL_COMMAND,
    CHAT_MESSAGE_SEND_COMMAND,
    CHAT_MODEL_SET_COMMAND,
    CHAT_USAGE_STATE
} from '../contract';
import { ComposerDeck, resizeComposerField } from './ComposerDeck';
import { renderWithHarness, stubViewport, type HarnessSeed } from './test-harness';

afterEach(() => {
    cleanup();
});

const CATALOG = ['vultr/coder', 'modal/glm-5.3-flash'];
const PROVIDER_SEED: HarnessSeed = {
    models: CATALOG,
    providerCatalog: CATALOG,
    providerLabels: ['coder (vultr)', 'glm-5.3-flash (modal)'],
    model: 'vultr/coder'
};

const AGENTS: AgentDefinition[] = [
    { id: 'pirate', name: 'Pirate', systemPrompt: 'Arr', messages: [], tools: ['web-search'] }
];

/** The one-row outer height jsdom measures: fallback line box + no padding + 1px frame x2. */
const ONE_ROW_HEIGHT = '24.4px';

describe('draft typing', () => {
    it('publishes every keystroke through chat.draft.set verbatim', () => {
        const view = renderWithHarness(<ComposerDeck />, PROVIDER_SEED);
        fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'Hello\nthere' } });
        expect(view.callsOf(CHAT_DRAFT_SET_COMMAND)).toEqual(['Hello\nthere']);
    });

    it('grows from the state, not from the browser default (rows=1 + border-box math)', () => {
        renderWithHarness(<ComposerDeck />, PROVIDER_SEED);
        const field = screen.getByTestId('composer-input') as HTMLTextAreaElement;
        // `rows="1"` is present, and the first measurement floors at the one-row
        // OUTER height (22.4 line box + 0 measured padding + the 2px frame), which
        // is exactly what keeps an empty composer from locking at two rows.
        expect(field.getAttribute('rows')).toBe('1');
        expect(field.style.height).toBe(ONE_ROW_HEIGHT);
    });

    it('keeps the field in sync when the draft changes without a keystroke', () => {
        const view = renderWithHarness(<ComposerDeck />, { ...PROVIDER_SEED, draft: 'restored draft' });
        const field = screen.getByTestId('composer-input') as HTMLTextAreaElement;
        expect(field.value).toBe('restored draft');
        expect(field.style.height).toBe(ONE_ROW_HEIGHT);
        act(() => {
            view.write<string>(CHAT_DRAFT_STATE, '');
        });
        expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).value).toBe('');
    });
});

describe('resizeComposerField (the height contract, measured geometry)', () => {
    const field = () => {
        const element = document.createElement('textarea');
        document.body.append(element);
        return element;
    };

    it('counts the 1px frame back onto scrollHeight, so the box is never 2px short', () => {
        const element = field();
        Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 100 });
        resizeComposerField(element);
        expect(element.style.height).toBe('102px');
        element.remove();
    });

    it('caps the visible editor at eight rows', () => {
        const element = field();
        Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 5000 });
        resizeComposerField(element);
        // 22.4 * 8 rows + 0 padding + the 2px frame.
        expect(element.style.height).toBe('181.2px');
        element.remove();
    });

    it('shrinks back to exactly one row after a deletion', () => {
        const element = field();
        element.style.height = '400px';
        Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 0 });
        resizeComposerField(element);
        expect(element.style.height).toBe(ONE_ROW_HEIGHT);
        element.remove();
    });
});

describe('Enter to send (desktop) and the newline rules', () => {
    it('submits on Enter at the md breakpoint and suppresses the newline', () => {
        const restore = stubViewport('desktop');
        const view = renderWithHarness(<ComposerDeck />, { ...PROVIDER_SEED, draft: 'ship it' });
        const field = screen.getByTestId('composer-input');
        try {
            expect(fireEvent.keyDown(field, { key: 'Enter', shiftKey: false })).toBe(false);
            expect(view.callsOf(CHAT_MESSAGE_SEND_COMMAND)).toEqual([undefined]);
        } finally {
            restore();
        }
    });

    it('leaves Shift+Enter as a newline', () => {
        const restore = stubViewport('desktop');
        const view = renderWithHarness(<ComposerDeck />, { ...PROVIDER_SEED, draft: 'ship it' });
        try {
            expect(fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter', shiftKey: true })).toBe(
                true
            );
            expect(view.callsOf(CHAT_MESSAGE_SEND_COMMAND)).toEqual([]);
        } finally {
            restore();
        }
    });

    it('never submits while an IME composition is confirming a candidate', () => {
        const restore = stubViewport('desktop');
        const view = renderWithHarness(<ComposerDeck />, { ...PROVIDER_SEED, draft: 'にほん' });
        try {
            fireEvent.keyDown(screen.getByTestId('composer-input'), {
                key: 'Enter',
                shiftKey: false,
                isComposing: true
            });
            expect(view.callsOf(CHAT_MESSAGE_SEND_COMMAND)).toEqual([]);
        } finally {
            restore();
        }
    });

    it('leaves Enter as a newline below the md breakpoint, where the button submits', () => {
        const restore = stubViewport('mobile');
        const view = renderWithHarness(<ComposerDeck />, { ...PROVIDER_SEED, draft: 'ship it' });
        try {
            expect(fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter', shiftKey: false })).toBe(
                true
            );
            expect(view.callsOf(CHAT_MESSAGE_SEND_COMMAND)).toEqual([]);
        } finally {
            restore();
        }
    });

    it('refuses to send an empty draft, even on Enter', () => {
        const restore = stubViewport('desktop');
        const view = renderWithHarness(<ComposerDeck />, PROVIDER_SEED);
        try {
            fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter', shiftKey: false });
            expect(view.callsOf(CHAT_MESSAGE_SEND_COMMAND)).toEqual([]);
        } finally {
            restore();
        }
    });

    it('submits through the form as well, without navigating', () => {
        const view = renderWithHarness(<ComposerDeck />, { ...PROVIDER_SEED, draft: 'via form' });
        expect(fireEvent.submit(screen.getByTestId('composer'))).toBe(false);
        expect(view.callsOf(CHAT_MESSAGE_SEND_COMMAND)).toEqual([undefined]);
    });
});

describe('the focus-gated send arrow', () => {
    it('does not exist until focus enters the composer', () => {
        renderWithHarness(<ComposerDeck />, { ...PROVIDER_SEED, draft: 'typed' });
        expect(screen.queryByTestId('send-button')).toBeNull();
    });

    it('appears on focus, disabled while the draft is blank', () => {
        renderWithHarness(<ComposerDeck />, PROVIDER_SEED);
        fireEvent.focus(screen.getByTestId('composer-input'));
        const send = screen.getByTestId('send-button') as HTMLButtonElement;
        expect(send.type).toBe('submit');
        expect(send.disabled).toBe(true);
    });

    it('arms itself once there is content, and clicking it sends', () => {
        const view = renderWithHarness(<ComposerDeck />, PROVIDER_SEED);
        const field = screen.getByTestId('composer-input');
        fireEvent.focus(field);
        fireEvent.change(field, { target: { value: 'ready' } });
        const send = screen.getByTestId('send-button') as HTMLButtonElement;
        expect(send.disabled).toBe(false);
        fireEvent.click(send);
        expect(view.callsOf(CHAT_MESSAGE_SEND_COMMAND)).toEqual([undefined]);
    });

    it('stays mounted while focus moves between the field, the arrow and the select', () => {
        renderWithHarness(<ComposerDeck />, { ...PROVIDER_SEED, draft: 'typed' });
        const field = screen.getByTestId('composer-input');
        fireEvent.focus(field);
        // focus moves field -> model select: relatedTarget is still inside the form
        fireEvent.blur(field, { relatedTarget: screen.getByTestId('model-select') });
        expect(screen.getByTestId('send-button')).not.toBeNull();
        // focus leaves the composer entirely
        fireEvent.blur(screen.getByTestId('model-select'), { relatedTarget: null });
        expect(screen.queryByTestId('send-button')).toBeNull();
    });
});

describe('the stop control while a reply is generating', () => {
    it('replaces the arrow with a cancel control that dispatches chat.message.cancel', () => {
        const view = renderWithHarness(<ComposerDeck />, { ...PROVIDER_SEED, status: 'sending', draft: 'asked' });
        const stop = screen.getByTestId('cancel-button') as HTMLButtonElement;
        expect(stop.disabled).toBe(false);
        expect(stop.getAttribute('aria-label')).toBe('Stop generating reply');
        fireEvent.click(stop);
        expect(view.callsOf(CHAT_MESSAGE_CANCEL_COMMAND)).toEqual([undefined]);
        expect(view.callsOf(CHAT_MESSAGE_SEND_COMMAND)).toEqual([]);
    });

    it('ignores Enter while a reply is in flight (one send at a time)', () => {
        const restore = stubViewport('desktop');
        const view = renderWithHarness(<ComposerDeck />, {
            ...PROVIDER_SEED,
            status: 'sending',
            streaming: 'partial',
            draft: 'another question'
        });
        try {
            fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter', shiftKey: false });
            expect(view.callsOf(CHAT_MESSAGE_SEND_COMMAND)).toEqual([]);
        } finally {
            restore();
        }
    });
});

describe('token usage and pickers', () => {
    it('prints the session token counter, and zero when the session has none', () => {
        const view = renderWithHarness(<ComposerDeck />, { ...PROVIDER_SEED, usage: { total_tokens: 1234 } });
        expect(screen.getByTestId('token-usage').textContent).toBe('Total tokens: 1234');
        act(() => view.write(CHAT_USAGE_STATE, null));
        expect(screen.getByTestId('token-usage').textContent).toBe('Total tokens: 0');
    });

    it('aligns each option label with its catalog id and keeps the full id as the value', async () => {
        const view = renderWithHarness(<ComposerDeck />, {
            ...PROVIDER_SEED,
            models: [...CATALOG],
            providerCatalog: [...CATALOG],
            providerLabels: ['coder (vultr)', 'glm-5.3-flash (modal)'],
            model: 'modal/glm-5.3-flash'
        });
        const select = screen.getByTestId('model-select') as HTMLSelectElement;
        await waitFor(() => expect(select.value).toBe('modal/glm-5.3-flash'));
        expect(Array.from(select.options).map((option) => [option.value, option.text])).toEqual([
            ['vultr/coder', 'coder (vultr)'],
            ['modal/glm-5.3-flash', 'glm-5.3-flash (modal)']
        ]);
        expect(screen.getByTestId('model-label').textContent).toBe('glm-5.3-flash (modal)');

        fireEvent.change(select, { target: { value: 'vultr/coder' } });
        expect(view.callsOf(CHAT_MODEL_SET_COMMAND)).toEqual(['vultr/coder']);
    });

    it('lists the agent registry beside the default "None" and dispatches chat.agent.set', () => {
        const view = renderWithHarness(<ComposerDeck />, { ...PROVIDER_SEED, agents: AGENTS, agent: '' });
        const select = screen.getByTestId('agent-select') as HTMLSelectElement;
        expect(Array.from(select.options).map((option) => [option.value, option.text])).toEqual([
            ['', 'None'],
            ['pirate', 'Pirate']
        ]);
        expect(screen.getByTestId('agent-label').textContent).toBe('None');
        fireEvent.change(select, { target: { value: 'pirate' } });
        expect(view.callsOf(CHAT_AGENT_SET_COMMAND)).toEqual(['pirate']);
    });

    it('shows the applied agent name as the picker text', () => {
        // The composer strip mirrors `chat.agent` — the cell `chat.agent.set` writes and
        // the one the send pipeline resolves the leading block from. `chat.activeAgentId`
        // is the Agents-tab editor's selection and is deliberately NOT what this line
        // reads, or the strip would advertise an agent the next send never applies.
        renderWithHarness(<ComposerDeck />, { ...PROVIDER_SEED, agents: AGENTS, agent: 'pirate' });
        expect(screen.getByTestId('agent-label').textContent).toBe('Pirate');
        expect((screen.getByTestId('agent-select') as HTMLSelectElement).value).toBe('pirate');
    });

    it('explains an empty catalog instead of defaulting to a phantom model', () => {
        renderWithHarness(<ComposerDeck />, { ...PROVIDER_SEED, models: [], providerLabels: [], model: '' });
        expect(screen.getByTestId('model-label').textContent).toBe('No models available');
        expect((screen.getByTestId('model-select') as HTMLSelectElement).disabled).toBe(true);
    });

    it('keeps a selected model that left the catalog selectable', () => {
        renderWithHarness(<ComposerDeck />, {
            ...PROVIDER_SEED,
            models: [CATALOG[1] as string],
            providerCatalog: [CATALOG[1] as string],
            providerLabels: ['glm-5.3-flash (modal)'],
            model: 'legacy/old-model'
        });
        const select = screen.getByTestId('model-select') as HTMLSelectElement;
        expect(Array.from(select.options).map((option) => option.value)).toEqual([
            'legacy/old-model',
            'modal/glm-5.3-flash'
        ]);
        expect(screen.getByTestId('model-label').textContent).toBe('old-model');
    });
});

describe('voice control', () => {
    it('starts recognition when idle', () => {
        const view = renderWithHarness(<ComposerDeck />, PROVIDER_SEED);
        const button = screen.getByTestId('voice-button') as HTMLButtonElement;
        expect(button.getAttribute('aria-pressed')).toBe('false');
        expect(button.getAttribute('aria-label')).toBe('Start voice input');
        // The mic is NOT focus-gated: it exists before the composer has focus.
        expect(screen.queryByTestId('send-button')).toBeNull();
        fireEvent.click(button);
        expect(view.callsOf('chat.voice.start')).toEqual([undefined]);
        expect(view.callsOf('chat.voice.stop')).toEqual([]);
    });

    it('stops recognition while listening, keeping the partial transcript', () => {
        const view = renderWithHarness(<ComposerDeck />, { ...PROVIDER_SEED, listening: true, draft: 'spoken words' });
        const button = screen.getByTestId('voice-button') as HTMLButtonElement;
        expect(button.getAttribute('aria-pressed')).toBe('true');
        expect(button.getAttribute('aria-label')).toBe('Stop voice input');
        fireEvent.click(button);
        expect(view.callsOf('chat.voice.stop')).toEqual([undefined]);
        // Stopping never touches the draft: the words stay for review/send.
        expect(view.read<string>(CHAT_LISTENING_STATE)).toBe(true);
        expect(view.callsOf(CHAT_DRAFT_SET_COMMAND)).toEqual([]);
    });
});

describe('the composer mutates nothing but the draft, the send and the voice session', () => {
    it('leaves the follow-output cell for the stage to own', () => {
        const view = renderWithHarness(<ComposerDeck />, { ...PROVIDER_SEED, autoscroll: false, draft: 'typed' });
        fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'typed more' } });
        fireEvent.click(screen.getByTestId('voice-button'));
        expect(view.read<boolean>(CHAT_AUTOSCROLL_STATE)).toBe(false);
        expect(view.callsOf('chat.autoscroll.toggle')).toEqual([]);
        expect(view.callsOf('chat.composer.focus')).toEqual([]);
        // Exactly the two dispatches the composer is allowed to make.
        expect([...view.calls.keys()]).toEqual([CHAT_DRAFT_SET_COMMAND, 'chat.voice.start']);
    });
});
