// NOTICES plugin tests: the two feedback surfaces and the rules that clear them.
//
// Headless, no render. The composition is core + notices: the plugin is deliberately
// exercised through the EVENT channel only (never by calling into it), because that is
// how the emitting plugins reach it — a bare `instance.emit(CHAT_ERROR_EVENT, ...)`
// models both a real emitter (plugins/source.ts:697-701 writes the cell AND emits) and
// an add-on that only announced its failure. The cell is then the truth a late-mounted
// view reads, which is the whole reason the subscription exists (events are live-only).
//
// `Date.now` is frozen so a row's `at` is an EXACT expected number rather than a range.
import { dashboard } from '@underload/dashboard';
import type { Dashboard } from '@underload/dashboard';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    CHAT_ERROR_EVENT,
    CHAT_ERROR_STATE,
    CHAT_MODE_STATE,
    CHAT_NOTICE_DISMISS_COMMAND,
    CHAT_NOTICE_EVENT,
    CHAT_NOTICES_SERVICE,
    CHAT_STREAM_COMPLETED_EVENT,
    CHAT_TRANSCRIPT_UPDATED_EVENT,
    type ChatMode,
    type ChatNotice,
    type ChatNoticeFeed
} from '../contract';
import { createCorePlugin } from './core';
import { createNoticesPlugin, MAX_NOTICE_ROWS } from './notices';
import { resetStorage } from './harness';

const NOW = 1767729600000;

let instance: Dashboard | null = null;

const compose = (): Dashboard => {
    instance = dashboard({ plugins: [createCorePlugin(), createNoticesPlugin()] });
    return instance;
};

/** The strip's rows, read through the service handle the view uses. */
const rowsOf = (chat: Dashboard): readonly ChatNotice[] =>
    chat.service<ChatNoticeFeed>(CHAT_NOTICES_SERVICE).get();

const announce = (chat: Dashboard, message: string): void => {
    chat.emit(CHAT_NOTICE_EVENT, { message });
};

beforeEach(() => {
    resetStorage();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
    instance?.dispose();
    instance = null;
    vi.restoreAllMocks();
});

describe('the error surface (`chat.error`)', () => {
    it('keeps the LAST failure an emitter announced, until something clears it', () => {
        const chat = compose();

        chat.emit(CHAT_ERROR_EVENT, { message: 'the provider relay refused the stream' });
        expect(chat.state<string>(CHAT_ERROR_STATE).get()).toBe(
            'the provider relay refused the stream'
        );

        // A repeat of the same failure re-applies the same text: the cell is
        // SameValueZero, so nothing churns and the banner keeps its single message.
        chat.emit(CHAT_ERROR_EVENT, { message: 'the provider relay refused the stream' });
        expect(chat.state<string>(CHAT_ERROR_STATE).get()).toBe(
            'the provider relay refused the stream'
        );

        // A newer failure REPLACES it: the strip shows what happened last, never a list.
        chat.emit(CHAT_ERROR_EVENT, { message: 'Conversation \'chat-9\' not found' });
        expect(chat.state<string>(CHAT_ERROR_STATE).get()).toBe(
            'Conversation \'chat-9\' not found'
        );
    });

    it('ignores an announcement with nothing to say', () => {
        const chat = compose();

        chat.emit(CHAT_ERROR_EVENT, { message: '   ' });

        expect(chat.state<string>(CHAT_ERROR_STATE).get()).toBe('');
        expect(rowsOf(chat)).toEqual([]);
    });

    it('is cleared by a successful action, not by an unrelated notice', () => {
        const chat = compose();
        chat.emit(CHAT_ERROR_EVENT, { message: 'catalog fetch failed' });
        announce(chat, 'System prompt saved.');

        // The notice belongs to the strip; the failure stays until the surface
        // actually succeeds (the background-refresh trap plugins/sessions.ts:143-147
        // documents is the reason a listing never clears it either).
        expect(chat.state<string>(CHAT_ERROR_STATE).get()).toBe('catalog fetch failed');
        expect(rowsOf(chat)).toHaveLength(1);

        // The stream completing is the strongest success a chat flow reports.
        chat.emit(CHAT_STREAM_COMPLETED_EVENT, {
            sessionId: 'chat-1',
            requestId: 'request-1',
            text: 'a reply'
        });
        expect(chat.state<string>(CHAT_ERROR_STATE).get()).toBe('');
        // The rows are NOT collateral damage: they still describe what happened.
        expect(rowsOf(chat)).toEqual([
            { id: 1, message: 'System prompt saved.', tone: 'info', at: NOW }
        ]);
    });

    it('is cleared when a flow rewrote the transcript', () => {
        const chat = compose();
        chat.emit(CHAT_ERROR_EVENT, { message: 'that conversation is gone' });

        chat.emit(CHAT_TRANSCRIPT_UPDATED_EVENT, { sessionId: 'chat-2', turnCount: 4 });

        expect(chat.state<string>(CHAT_ERROR_STATE).get()).toBe('');
    });

    it('leaves with the namespace on a mode switch', () => {
        const chat = compose();
        announce(chat, 'Forked 3 messages into a new conversation.');
        chat.state<ChatMode>(CHAT_MODE_STATE).set('offline');

        expect(rowsOf(chat)).toEqual([]);
        // The banner half is the core's own reset (plugins/core.ts:548); asserting it
        // here keeps the pair's behaviour documented in one place.
        expect(chat.state<string>(CHAT_ERROR_STATE).get()).toBe('');
    });
});

describe('the notice strip (`chat.notices`)', () => {
    it('appends one row per announcement, oldest first', () => {
        const chat = compose();

        announce(chat, 'System prompt saved.');
        announce(chat, 'System prompt saved.');
        announce(chat, 'Forked 3 messages into a new conversation.');

        // Two identical announcements are two events the operator caused; only the row
        // ids differ, which is what keeps each one individually dismissable.
        expect(rowsOf(chat)).toEqual([
            { id: 1, message: 'System prompt saved.', tone: 'info', at: NOW },
            { id: 2, message: 'System prompt saved.', tone: 'info', at: NOW },
            {
                id: 3,
                message: 'Forked 3 messages into a new conversation.',
                tone: 'info',
                at: NOW
            }
        ]);
    });

    it('drops the oldest row past the cap', () => {
        const chat = compose();

        for (let index = 0; index < MAX_NOTICE_ROWS + 1; index += 1) {
            announce(chat, `notice ${index + 1}`);
        }

        expect(rowsOf(chat)).toEqual([
            { id: 2, message: 'notice 2', tone: 'info', at: NOW },
            { id: 3, message: 'notice 3', tone: 'info', at: NOW },
            { id: 4, message: 'notice 4', tone: 'info', at: NOW }
        ]);
    });

    it('never puts a failure on the strip', () => {
        const chat = compose();

        chat.emit(CHAT_ERROR_EVENT, { message: 'the provider relay refused the stream' });

        // The two surfaces stay disjoint, so one message is never shown twice: the
        // stage's `error-banner` owns failures, this strip owns consequences.
        expect(rowsOf(chat)).toEqual([]);
        expect(chat.state<string>(CHAT_ERROR_STATE).get()).toBe(
            'the provider relay refused the stream'
        );
    });

    it('is a state-shaped handle a view can subscribe to', () => {
        const chat = compose();
        const feed = chat.service<ChatNoticeFeed>(CHAT_NOTICES_SERVICE);
        const notified: number[] = [];
        const unsubscribe = feed.subscribe(() => notified.push(feed.get().length));

        announce(chat, 'System prompt saved.');
        // An equal write notifies nobody (the framework's own change-detection rule),
        // which is what stops a re-push from looping useSyncExternalStore.
        feed.set(feed.get());
        unsubscribe();
        announce(chat, 'Forked 3 messages into a new conversation.');

        expect(notified).toEqual([1]);
        expect(rowsOf(chat)).toHaveLength(2);
    });
});

describe('chat.notice.dismiss', () => {
    it('removes exactly the addressed row and returns what is left', () => {
        const chat = compose();
        announce(chat, 'first');
        announce(chat, 'second');
        announce(chat, 'third');

        const remaining = chat.execute<number, number>(CHAT_NOTICE_DISMISS_COMMAND, 2);

        expect(remaining).toBe(2);
        expect(rowsOf(chat)).toEqual([
            { id: 1, message: 'first', tone: 'info', at: NOW },
            { id: 3, message: 'third', tone: 'info', at: NOW }
        ]);
    });

    it('clears the whole strip and dismisses the surfaced error with it', () => {
        const chat = compose();
        chat.emit(CHAT_ERROR_EVENT, { message: 'a failure to acknowledge' });
        announce(chat, 'first');

        const remaining = chat.execute<void, number>(CHAT_NOTICE_DISMISS_COMMAND);

        // One gesture acknowledges the feedback: the strip empties and the banner goes
        // with it (the "cleared by dismissal" half of the rule).
        expect(remaining).toBe(0);
        expect(rowsOf(chat)).toEqual([]);
        expect(chat.state<string>(CHAT_ERROR_STATE).get()).toBe('');
    });

    it('is a no-op that still answers with zero when there is nothing to dismiss', () => {
        const chat = compose();
        chat.emit(CHAT_ERROR_EVENT, { message: 'failure with no notice' });

        expect(chat.execute<number, number>(CHAT_NOTICE_DISMISS_COMMAND, 99)).toBe(0);
        expect(chat.state<string>(CHAT_ERROR_STATE).get()).toBe('');
    });
});
