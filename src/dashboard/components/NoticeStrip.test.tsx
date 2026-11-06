// NoticeStrip: the transient feedback strip's render and dismiss contract.
//
// The strip is fed by the `chat.notices` SERVICE, so the harness registers that id as
// a cell and publishes the handle (test-harness.tsx) — seeding rows is a plain
// `seed: { notices: [...] }`, and a live push is an `act(() => write(...))`, which is
// what proves the component SUBSCRIBES to the feed rather than reading it once.
//
// The rules pinned here:
//   1. an empty feed renders NOTHING (no reserved row in the viewport-locked stage);
//   2. one row per notice, in feed order, with the tone as an attribute;
//   3. dismissal is always a command (`chat.notice.dismiss`), never a local state flip,
//      and both the row control and the group control go through the same id;
//   4. the strip never renders the error surface — `error-banner` belongs to ChatStage.
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
    CHAT_NOTICES_SERVICE,
    type ChatNotice,
    type ChatNoticeTone
} from '../contract';
import { NoticeStrip } from './NoticeStrip';
import { makeNotice, renderWithHarness, type HarnessSeed } from './test-harness';

afterEach(() => {
    cleanup();
});

const ROWS: readonly ChatNotice[] = [
    makeNotice(1, 'System prompt saved.'),
    makeNotice(2, 'Forked 3 messages into a new conversation.', { tone: 'warn' })
];

const SEED: HarnessSeed = { notices: ROWS };

describe('an empty feed', () => {
    it('renders nothing at all, and reserves no row in the stage', () => {
        const { container } = renderWithHarness(<NoticeStrip />, {});

        expect(screen.queryByTestId('notice-strip')).toBeNull();
        // No stray text either: the component returns null, it does not hide a wrapper.
        expect(container.querySelector('.notice')).toBeNull();
    });

    it('never claims the error surface', () => {
        renderWithHarness(<NoticeStrip />, SEED);

        expect(screen.queryByTestId('error-banner')).toBeNull();
    });
});

describe('the rows', () => {
    it('renders one row per notice, oldest first, with the text verbatim', () => {
        renderWithHarness(<NoticeStrip />, SEED);
        const strip = screen.getByTestId('notice-strip');
        const rows = within(strip).getAllByTestId(/notice-row-/);

        expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
            'notice-row-1',
            'notice-row-2'
        ]);
        expect(within(rows[0]).getByText('System prompt saved.').textContent).toBe(
            'System prompt saved.'
        );
        expect(within(rows[1]).getByText('Forked 3 messages into a new conversation.').textContent)
            .toBe('Forked 3 messages into a new conversation.');
        // Tone is an attribute, so notices.css colours it and a test can read it.
        expect(rows[0].getAttribute('data-tone')).toBe('info');
        expect(rows[1].getAttribute('data-tone')).toBe('warn');
    });

    it('is one live region so an appended row is announced without stealing focus', () => {
        renderWithHarness(<NoticeStrip />, SEED);
        const strip = screen.getByTestId('notice-strip');

        expect(strip.getAttribute('role')).toBe('status');
        expect(strip.className).toBe('notice');
    });

    it('falls back to the neutral tone for a value the stylesheet does not know', () => {
        const odd: HarnessSeed = {
            notices: [makeNotice(7, 'a future tone', { tone: 'critical' as ChatNoticeTone })]
        };
        renderWithHarness(<NoticeStrip />, odd);

        expect(screen.getByTestId('notice-row-7').getAttribute('data-tone')).toBe('info');
    });

    it('re-renders when the feed pushes, without a remount', () => {
        const view = renderWithHarness(<NoticeStrip />, {});
        expect(screen.queryByTestId('notice-strip')).toBeNull();

        act(() => view.write<readonly ChatNotice[]>(CHAT_NOTICES_SERVICE, ROWS));

        expect(screen.getByTestId('notice-strip')).toBeTruthy();
        expect(within(screen.getByTestId('notice-strip')).getAllByTestId(/notice-row-/)).toHaveLength(
            2
        );
        // The reverse edge: a cleared feed takes the strip off the screen again.
        act(() => view.write<readonly ChatNotice[]>(CHAT_NOTICES_SERVICE, []));
        expect(screen.queryByTestId('notice-strip')).toBeNull();
    });
});

describe('dismissal', () => {
    it('addresses one row through chat.notice.dismiss and leaves the other standing', () => {
        const view = renderWithHarness(<NoticeStrip />, SEED);

        fireEvent.click(screen.getByTestId('notice-dismiss-2'));

        expect(view.callsOf('chat.notice.dismiss')).toEqual([2]);
        // The harness mirrors the real command's write, so the row leaving the DOM is
        // the observable half of "the control works", not just the dispatch.
        expect(screen.queryByTestId('notice-row-2')).toBeNull();
        expect(screen.getByTestId('notice-row-1').textContent).toContain('System prompt saved.');
        expect(screen.getByTestId('notice-strip')).toBeTruthy();
    });

    it('clears the whole strip through the same command with no input', () => {
        const view = renderWithHarness(<NoticeStrip />, SEED);
        const clear = screen.getByTestId('notice-clear');

        expect(clear.tagName).toBe('BUTTON');
        expect(clear.textContent).toBe('Dismiss all');
        expect(clear.getAttribute('aria-label')).toBe('Dismiss all notices');

        fireEvent.click(clear);

        expect(view.callsOf('chat.notice.dismiss')).toEqual([undefined]);
        expect(screen.queryByTestId('notice-strip')).toBeNull();
    });

    it('gives every row its own labelled dismiss control', () => {
        renderWithHarness(<NoticeStrip />, SEED);
        const dismissals = screen.getAllByTestId(/^notice-dismiss-/);

        expect(dismissals).toHaveLength(2);
        for (const control of dismissals) {
            expect(control.tagName).toBe('BUTTON');
            expect(control.getAttribute('aria-label')).toBe('Dismiss notice');
            // The control is a SIBLING of the message text, never an ancestor of it
            // (the row contract sessions.css:174-179 states for the same reason).
            expect(within(control).queryByText(/System prompt saved./)).toBeNull();
        }
    });
});
