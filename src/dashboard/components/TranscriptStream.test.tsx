// TranscriptStream: what the log paints, in which order, and with which ids.
//
// Coverage comes from the oracle's render sites (src/components/ChatAssistantApp.tsx
// 4900-5073): the system-prompt draft row that leads an unstarted chat, the
// persisted turns, the pending user bubble, the streaming assistant row (three
// dots until the FIRST token), and the empty state. Every expectation is an exact
// value.
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
    CHAT_EDITING_INDEX_STATE,
    CHAT_STREAMING_STATE,
    CHAT_SYSTEM_BEGIN_COMMAND,
    CHAT_TURNS_STATE,
    type ChatTurn
} from '../contract';
import { TranscriptStream } from './TranscriptStream';
import { makeTurn, renderWithHarness } from './test-harness';

afterEach(() => {
    cleanup();
});

const CATALOG = ['vultr/coder', 'modal/glm-5.3-flash'];
const LABELS = ['coder (vultr)', 'glm-5.3-flash (modal)'];

/** Seed the provider pair every attribution goes through. */
const providerSeed = { models: CATALOG, providerCatalog: CATALOG, providerLabels: LABELS, model: 'vultr/coder' };

describe('the transcript container', () => {
    it('is a live region declared at mount, before any text arrives', () => {
        renderWithHarness(<TranscriptStream />, providerSeed);
        const list = screen.getByTestId('transcript');
        expect(list.tagName).toBe('OL');
        expect(list.getAttribute('role')).toBe('log');
        expect(list.getAttribute('aria-live')).toBe('polite');
        expect(list.getAttribute('aria-atomic')).toBe('false');
        expect(list.getAttribute('aria-relevant')).toBe('additions text');
    });
});

describe('empty state', () => {
    it('invites the first chat and still leads with the empty system prompt row', () => {
        renderWithHarness(<TranscriptStream />, providerSeed);
        expect(screen.getByTestId('empty-chat-state').textContent).toBe(
            'Start a conversationAsk the assistant anything to create your first chat.'
        );
        // The draft turn renders even with no text, showing the literal placeholder.
        expect(screen.getByTestId('system-prompt-turn')).not.toBeNull();
        expect(screen.getByTestId('system-prompt-value').textContent).toBe('no prompt');
        expect(screen.getByTestId('system-prompt-value').getAttribute('data-empty')).toBe('true');
        // Nothing to copy yet, so the draft strip is absent.
        expect(screen.queryByTestId('copy-system-prompt')).toBeNull();
    });

    it('shows the saved draft instead of the placeholder once text exists', () => {
        renderWithHarness(<TranscriptStream />, { ...providerSeed, systemDraft: 'Be terse.' });
        expect(screen.getByTestId('system-prompt-value').textContent).toBe('Be terse.');
        expect(screen.getByTestId('system-prompt-value').getAttribute('data-empty')).toBe('false');
        expect(screen.getByTestId('copy-system-prompt')).not.toBeNull();
    });

    it('yields the draft row to a persisted leading system turn', () => {
        const turns: ChatTurn[] = [makeTurn(0, 'system', 'You are helpful.')];
        renderWithHarness(<TranscriptStream />, { ...providerSeed, turns, systemDraft: 'You are helpful.' });
        expect(screen.queryByTestId('system-prompt-turn')).toBeNull();
        expect(screen.getByTestId('message-turn-0')).not.toBeNull();
    });

    it('opens the prompt editor through chat.system.begin', () => {
        const view = renderWithHarness(<TranscriptStream />, { ...providerSeed, systemDraft: 'Be terse.' });
        fireEvent.click(screen.getByTestId('system-prompt-value'));
        expect(view.callsOf(CHAT_SYSTEM_BEGIN_COMMAND)).toEqual([undefined]);
    });
});

describe('persisted turns', () => {
    it('renders every turn in order with its role rail and attribution', async () => {
        const turns = [
            makeTurn(0, 'system', 'You are helpful.'),
            makeTurn(1, 'user', 'What is 2+2?'),
            makeTurn(2, 'assistant', 'It is 4.')
        ];
        renderWithHarness(<TranscriptStream />, { ...providerSeed, turns });
        expect(screen.getByTestId('message-turn-0').className).toBe('msg msg--system');
        expect(screen.getByTestId('message-turn-1').className).toBe('msg msg--user');
        expect(screen.getByTestId('message-turn-2').className).toBe('msg msg--assistant');
        // The label resolves through the provider's aligned labels, not the raw id.
        await waitFor(() => expect(screen.getByTestId('message-model-2').textContent).toBe('coder (vultr)'));
        expect(screen.getByTestId('message-label-1').textContent).toBe('user');
        expect(screen.getByTestId('message-content-2').textContent).toBe('It is 4.');
    });

    it('folds a collapsed turn to its label plus the first line, and expands on the preview', () => {
        const turns = [makeTurn(0, 'assistant', 'first line\nsecond line', { collapsed: true })];
        const view = renderWithHarness(<TranscriptStream />, { ...providerSeed, turns });
        expect(screen.getByTestId('message-preview-0').textContent).toBe('first line');
        expect(screen.queryByTestId('message-content-0')).toBeNull();
        fireEvent.click(screen.getByTestId('message-preview-0'));
        expect(view.callsOf('chat.turn.toggle')).toEqual([0]);
    });

    it('keeps one editor across the whole list and routes the commit to chat.message.update', async () => {
        const turns = [
            makeTurn(0, 'user', 'question one'),
            makeTurn(1, 'user', 'question two')
        ];
        const view = renderWithHarness(<TranscriptStream />, { ...providerSeed, turns });

        fireEvent.click(screen.getByTestId('message-content-1'));
        // The one-editor rule is store state, not row state.
        expect(view.read<number | null>(CHAT_EDITING_INDEX_STATE)).toBe(1);
        const editor = screen.getByTestId('message-content-1');
        expect(editor.getAttribute('contenteditable')).toBe('true');
        // Every OTHER row's mutation chrome is greyed but still rendered.
        expect((screen.getByTestId('copy-message-0') as HTMLButtonElement).disabled).toBe(true);

        editor.textContent = 'edited question';
        fireEvent.blur(editor);
        await waitFor(() =>
            expect(view.callsOf('chat.message.update')).toEqual([{ index: 1, content: 'edited question' }])
        );
        expect(view.read<number | null>(CHAT_EDITING_INDEX_STATE)).toBeNull();
        expect(screen.getByTestId('message-content-1').getAttribute('contenteditable')).toBeNull();
    });

    it('cancels an abandoned edit on Escape without any history rewrite', async () => {
        const turns = [makeTurn(0, 'user', 'persisted')];
        const view = renderWithHarness(<TranscriptStream />, { ...providerSeed, turns });
        fireEvent.click(screen.getByTestId('message-content-0'));
        const editor = screen.getByTestId('message-content-0');
        editor.textContent = 'half typed junk';
        fireEvent.keyDown(editor, { key: 'Escape' });
        expect(view.callsOf('chat.message.update')).toEqual([]);
        expect(view.read<number | null>(CHAT_EDITING_INDEX_STATE)).toBeNull();
        // The keyed remount restored the persisted text (React cannot un-mutate a
        // contentEditable node, so this is the only reliable revert).
        await waitFor(() =>
            expect(screen.getByTestId('message-content-0').textContent).toBe('persisted')
        );
    });
});

describe('in-flight turns', () => {
    it('renders the pending user bubble verbatim and no controls for it', () => {
        renderWithHarness(<TranscriptStream />, {
            ...providerSeed,
            pending: { text: 'What is 2+2?', at: 1767225600000 }
        });
        expect(screen.getByTestId('pending-user-message').textContent).toBe('What is 2+2?');
        // In-flight turns carry no controls panel, hence no chevrons either.
        expect(screen.queryAllByTestId(/turn-controls-/)).toHaveLength(0);
        // And the empty-state card is gone: something IS happening.
        expect(screen.queryByTestId('empty-chat-state')).toBeNull();
    });

    it('shows the three-dot loading state until the first streamed token', () => {
        const view = renderWithHarness(<TranscriptStream />, {
            ...providerSeed,
            status: 'sending',
            streaming: '',
            pending: { text: 'What is 2+2?', at: 1767225600000 }
        });
        const loading = screen.getByTestId('streaming-loading');
        expect(loading.getAttribute('role')).toBe('status');
        expect(loading.querySelectorAll('.msg__dot')).toHaveLength(3);
        expect(screen.queryByTestId('streaming-message')).toBeNull();

        act(() => {
            view.write<string>(CHAT_STREAMING_STATE, 'It is');
        });
        // The first token REPLACES the dots; the two states never coexist.
        expect(screen.queryByTestId('streaming-loading')).toBeNull();
        expect(screen.getByTestId('streaming-message').textContent).toBe('It is');
    });

    it('streams plain text, with no markdown interpretation', () => {
        renderWithHarness(<TranscriptStream />, {
            ...providerSeed,
            status: 'streaming',
            streaming: '**four**\n\n`2 + 2`'
        });
        const bubble = screen.getByTestId('streaming-message');
        expect(bubble.textContent).toBe('**four**\n\n`2 + 2`');
        expect(bubble.childNodes).toHaveLength(1);
    });

    it('attributes the streaming row with the producing model', async () => {
        renderWithHarness(<TranscriptStream />, { ...providerSeed, status: 'sending', streaming: '' });
        await waitFor(() => expect(screen.getByTestId('streaming-message-model').textContent).toBe('coder (vultr)'));
    });

    it('renders neither pending nor streaming row when nothing is in flight', () => {
        renderWithHarness(<TranscriptStream />, providerSeed);
        expect(screen.queryByTestId('pending-user-turn')).toBeNull();
        expect(screen.queryByTestId('streaming-turn')).toBeNull();
    });
});

describe('control suppression while the record is being rewritten', () => {
    it('hides mutation controls while chat.status is saving, but keeps the rows', () => {
        const turns = [makeTurn(0, 'user', 'question')];
        renderWithHarness(<TranscriptStream />, { ...providerSeed, turns, status: 'saving' });
        expect(screen.getByTestId('message-turn-0')).not.toBeNull();
        expect(screen.getByTestId('message-content-0')).not.toBeNull();
        expect(screen.queryByTestId('copy-message-0')).toBeNull();
        expect(screen.queryByTestId('delete-message-0')).toBeNull();
    });
});
