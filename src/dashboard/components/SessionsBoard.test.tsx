// SessionsBoard + VoiceButton: the shared row chrome, and the voice affordance.
//
// The board is the chrome every sidebar registry reuses, so the structural rules
// are asserted ONCE here against a minimal host (the three ChatSidebar tabs then
// inherit them): the select control and the overlaid controls are SIBLINGS
// (behavior oracle ChatAssistantApp.tsx:4282-4317), a registry with no select
// command renders NO dead button, and an empty registry says so.
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionsBoard, type BoardEntry } from './SessionsBoard';
import { renderWithHarness } from './test-harness';

afterEach(() => {
    cleanup();
});

const ENTRIES: BoardEntry[] = [
    { id: 'one', title: 'First row', meta: '2 messages · complete', selected: true },
    { id: 'two', title: 'Second row', meta: '1 messages · pending' }
];

/** Board host with every affordance switched on. */
function mountBoard(over: Partial<Parameters<typeof SessionsBoard>[0]> = {}) {
    const selected: string[] = [];
    const removed: string[] = [];
    const renamed: Array<[string, string]> = [];
    const view = renderWithHarness(
        <ul data-testid="host">
            <SessionsBoard
                heading="Conversations"
                entries={ENTRIES}
                emptyLabel="No chats yet."
                listTestId="board-list"
                emptyTestId="board-empty"
                entryTestId={(entry) => `row-${entry.id}`}
                deleteTestId={(entry) => `row-delete-${entry.id}`}
                renameTestId={(entry) => `row-rename-${entry.id}`}
                deleteLabel="Delete conversation"
                selectLabel={(entry) => `Open ${entry.title}`}
                onSelect={(id) => selected.push(id)}
                onDelete={(id) => removed.push(id)}
                onRename={(id, title) => renamed.push([id, title])}
                {...over}
            />
        </ul>
    );
    return { ...view, selected, removed, renamed };
}

describe('the board chrome', () => {
    it('draws the heading, the live count and one row per entry, in order', () => {
        mountBoard();
        expect(screen.getByText('Conversations')).not.toBeNull();
        expect(screen.getByTestId('board-list').querySelectorAll('.rail__entry')).toHaveLength(2);
        expect(screen.getByTestId('row-one').querySelector('.rail__title')?.textContent).toBe('First row');
        expect(screen.getByTestId('row-two').querySelector('.rail__meta')?.textContent).toBe(
            '1 messages · pending'
        );
        // The count is the registry size, and it follows the store.
        const counted = screen.getByText('Conversations').parentElement?.textContent;
        expect(counted).toBe('Conversations2');
    });

    it('honours an explicit count and a caller-owned empty message', () => {
        mountBoard({ count: 7 });
        expect(screen.getByText('Conversations').parentElement?.textContent).toBe('Conversations7');
        cleanup();
        mountBoard({ entries: [] });
        expect(screen.getByTestId('board-empty').textContent).toBe('No chats yet.');
        expect(screen.queryByTestId('board-list')).toBeNull();
    });

    it('marks the selected row on the row AND on its select control', () => {
        mountBoard();
        const row = screen.getByTestId('row-one');
        expect(row.getAttribute('data-selected')).toBe('true');
        const select = row.querySelector('.rail__item') as HTMLElement;
        expect(select.getAttribute('aria-current')).toBe('true');
        expect(select.getAttribute('data-selected')).toBe('true');
        // The count of selected rows is exactly one.
        expect(document.querySelectorAll('.rail__item[aria-current="true"]')).toHaveLength(1);
    });

    it('labels the select control with the caller copy, never with the raw id', () => {
        mountBoard();
        expect(screen.getByTestId('row-one').querySelector('.rail__item')?.getAttribute('aria-label')).toBe(
            'Open First row'
        );
    });
});

describe('the sibling-control structure', () => {
    it('never nests the delete or rename control inside the select control', () => {
        mountBoard();
        const row = screen.getByTestId('row-one');
        const select = row.querySelector('.rail__item') as HTMLElement;
        const remove = screen.getByTestId('row-delete-one');
        const rename = screen.getByTestId('row-rename-one');
        expect(select.contains(remove)).toBe(false);
        expect(select.contains(rename)).toBe(false);
        expect(select.querySelector('button')).toBeNull();
        // Both live in one group that is a sibling of the select control.
        const group = row.querySelector('.rail__actions') as HTMLElement;
        expect(group.parentElement).toBe(row);
        expect(within(group).getByTestId('row-rename-one')).not.toBeNull();
        expect(within(group).getByTestId('row-delete-one')).not.toBeNull();
        expect(group.getAttribute('role')).toBe('group');
    });

    it('dispatches select and delete apart, so a delete can never also select', () => {
        const board = mountBoard();
        fireEvent.click(screen.getByTestId('row-two').querySelector('.rail__item') as Element);
        fireEvent.click(screen.getByTestId('row-delete-one'));
        expect(board.selected).toEqual(['two']);
        expect(board.removed).toEqual(['one']);
    });

    it('names the delete control from the caller copy, per row', () => {
        mountBoard();
        expect(screen.getByTestId('row-delete-one').getAttribute('aria-label')).toBe('Delete conversation');
    });

    it('renders a plain row (no dead button) for a registry with no select handler', () => {
        const board = mountBoard({ onSelect: undefined, onDelete: undefined, onRename: undefined });
        const row = screen.getByTestId('row-one');
        expect(row.querySelector('button')).toBeNull();
        expect(row.querySelector('.rail__item--static')).not.toBeNull();
        expect(board.selected).toEqual([]);
        // No affordances means no overlaid group either.
        expect(row.querySelector('.rail__actions')).toBeNull();
    });

    it('disables every control of an inert row without removing it', () => {
        mountBoard({ entries: [{ id: 'busy', title: 'Busy row', selected: true, disabled: true }] });
        const row = screen.getByTestId('row-busy');
        expect((row.querySelector('.rail__item') as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByTestId('row-delete-busy') as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByTestId('row-rename-busy') as HTMLButtonElement).disabled).toBe(true);
    });
});

describe('inline rename through the board', () => {
    it('opens the single-line editor on the row, commits on Enter, and never selects while renaming', () => {
        const board = mountBoard();
        fireEvent.click(screen.getByTestId('row-rename-one'));
        const editor = screen.getByTestId('rename-entry-one');
        expect(editor.getAttribute('contenteditable')).toBe('true');
        expect(editor.getAttribute('aria-multiline')).toBe('false');
        expect(editor.getAttribute('aria-label')).toBe('Conversation title');
        // The select control is REPLACED by the editor, so the row cannot fire a
        // selection underneath a rename.
        expect(screen.getByTestId('row-one').querySelector('.rail__item')).toBeNull();
        editor.textContent = 'Renamed row';
        fireEvent.keyDown(editor, { key: 'Enter' });
        expect(board.renamed).toEqual([['one', 'Renamed row']]);
        expect(screen.getByTestId('row-one').querySelector('.rail__item')).not.toBeNull();
    });

    it('commits a blur as well (the auto-save-on-blur rule)', () => {
        const board = mountBoard();
        fireEvent.click(screen.getByTestId('row-rename-two'));
        const editor = screen.getByTestId('rename-entry-two');
        editor.textContent = 'Blurred name';
        fireEvent.blur(editor);
        expect(board.renamed).toEqual([['two', 'Blurred name']]);
    });

    it('drops a blank or unchanged commit and restores the stored title', () => {
        const board = mountBoard();
        fireEvent.click(screen.getByTestId('row-rename-one'));
        fireEvent.keyDown(screen.getByTestId('rename-entry-one'), { key: 'Escape' });
        expect(board.renamed).toEqual([]);
        expect(screen.getByTestId('row-one').querySelector('.rail__title')?.textContent).toBe('First row');

        fireEvent.click(screen.getByTestId('row-rename-one'));
        const editor = screen.getByTestId('rename-entry-one');
        editor.textContent = '   ';
        fireEvent.blur(editor);
        expect(board.renamed).toEqual([]);

        fireEvent.click(screen.getByTestId('row-rename-one'));
        fireEvent.blur(screen.getByTestId('rename-entry-one'));
        // Unchanged text is not a rename.
        expect(board.renamed).toEqual([]);
    });

    it('starts a rename from the row itself with F2 and a double click', () => {
        mountBoard();
        const select = screen.getByTestId('row-two').querySelector('.rail__item') as HTMLElement;
        fireEvent.keyDown(select, { key: 'F2' });
        expect(screen.getByTestId('rename-entry-two')).not.toBeNull();
        cleanup();
        mountBoard();
        fireEvent.doubleClick(screen.getByTestId('row-one').querySelector('.rail__item') as HTMLElement);
        expect(screen.getByTestId('rename-entry-one')).not.toBeNull();
    });
});
