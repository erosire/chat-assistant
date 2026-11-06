// VoiceButton: the always-visible mic dock and its command dispatch.
//
// The recognizer lifecycle (transcripts landing in `chat.draft`, the
// finished-utterance auto-send, the unsupported-browser diagnosis) lives behind
// `chat.voice.start` / `chat.voice.stop` in the chat plugin; this component only
// reflects `chat.listening` and dispatches the toggle. Render contract: oracle
// src/components/ChatAssistantApp.tsx:4174-4270 (wiring) and 5205-5221 (button).
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CHAT_DRAFT_STATE, CHAT_LISTENING_STATE } from '../contract';
import { VoiceButton } from './VoiceButton';
import { renderWithHarness } from './test-harness';

afterEach(() => {
    cleanup();
});

describe('the idle affordance', () => {
    it('is the start control, and it is visible before the composer has focus', () => {
        const view = renderWithHarness(<VoiceButton />, { listening: false });
        const button = screen.getByTestId('voice-button') as HTMLButtonElement;
        expect(button.getAttribute('aria-pressed')).toBe('false');
        expect(button.getAttribute('aria-label')).toBe('Start voice input');
        expect(button.getAttribute('title')).toBe('Start voice input');
        expect(button.getAttribute('data-listening')).toBe('false');
        expect(button.className).toBe('composer__voice');
        // The idle glyph is the shared mic icon (never a unicode character).
        expect(button.querySelector('svg')?.getAttribute('data-icon')).toBe('mic');
        fireEvent.click(button);
        expect(view.callsOf('chat.voice.start')).toEqual([undefined]);
        expect(view.callsOf('chat.voice.stop')).toEqual([]);
    });
});

describe('the listening affordance', () => {
    it('flips label, pressed state and glyph from the store cell alone', () => {
        const view = renderWithHarness(<VoiceButton />, { listening: false });
        act(() => view.write<boolean>(CHAT_LISTENING_STATE, true));
        const button = screen.getByTestId('voice-button') as HTMLButtonElement;
        expect(button.getAttribute('aria-pressed')).toBe('true');
        expect(button.getAttribute('aria-label')).toBe('Stop voice input');
        expect(button.className).toBe('composer__voice is-active');
        expect(button.querySelector('svg')?.getAttribute('data-icon')).toBe('close');
    });

    it('stops the session through chat.voice.stop and never touches the draft', () => {
        const view = renderWithHarness(<VoiceButton />, { listening: true, draft: 'spoken words' });
        fireEvent.click(screen.getByTestId('voice-button'));
        expect(view.callsOf('chat.voice.stop')).toEqual([undefined]);
        expect(view.callsOf('chat.voice.start')).toEqual([]);
        // An explicit stop keeps the partial transcript for review/send (oracle
        // 4175-4182), so the draft cell is left exactly as the session left it.
        expect(view.read<string>(CHAT_DRAFT_STATE)).toBe('spoken words');
        expect(view.callsOf('chat.draft.set')).toEqual([]);
    });
});
