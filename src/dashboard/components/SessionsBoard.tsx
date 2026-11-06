// SessionsBoard — the shared list chrome every sidebar tab reuses.
//
// Presentational by design: it draws a heading, a count chip and a list of rows,
// and every mutation is a callback the owner (ChatSidebar) wires to a command.
// The three registries (conversations / agents / tools) are the SAME affordance
// — a full-width select row with overlaid controls — which is why one component
// serves all three instead of three near-duplicates.
//
// THE STRUCTURE RULE (behavior oracle, ChatAssistantApp.tsx:4282-4317):
// a row is a positioning context holding TWO SIBLING controls — the select
// control (fills the row) and the delete control (absolutely pinned to the row's
// top-right corner). The delete control is NEVER nested inside the select
// control: nested interactive elements are invalid HTML, and a delete click
// would bubble into a selection change.
//
// Styles come from styles/sessions.css (class vocabulary `.rail*`); nothing here
// writes an inline style object.
import { useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { CloseIcon, EditIcon } from '../../icons';
import { InlineEdit } from './InlineEdit';

/** One registry row as the board renders it (ids are opaque to this component). */
export type BoardEntry = {
    id: string;
    title: string;
    /** Secondary line: "12 messages · complete", "3 turns · 2 tools", "native". */
    meta?: string;
    /** The row the surface currently owns (accent rail + aria-current). */
    selected?: boolean;
    /** Row is inert (a save/delete is in flight) — its controls are disabled. */
    disabled?: boolean;
};

export type SessionsBoardProps = {
    /** Heading text drawn above the list ("Conversations" / "Agents" / "Tools"). */
    heading: string;
    /** Count chip beside the heading; defaults to `entries.length`. */
    count?: number;
    entries: readonly BoardEntry[];
    /** Copy shown when the registry is empty (the oracle's "No chats yet."). */
    emptyLabel: string;
    /** data-testid for the list container, e.g. "sidebar-list-chat". */
    listTestId?: string;
    /** data-testid for the empty-state node. */
    emptyTestId?: string;
    /** Row testid builder — conversation rows must be `session-entry-{id}`. */
    entryTestId: (entry: BoardEntry) => string;
    /** Accessible name of the row's select control. */
    selectLabel: (entry: BoardEntry) => string;
    /** Omit for a read-only registry (renders a div, never a dead button). */
    onSelect?: (id: string) => void;
    /** Omit to hide the delete affordance entirely (read-only registries). */
    onDelete?: (id: string) => void;
    /** aria/title label for the delete control. */
    deleteLabel?: string;
    deleteTestId?: (entry: BoardEntry) => string;
    /**
     * Omit to hide the rename affordance. When present, the row's edit icon (or
     * a double-click / F2 on the row) swaps the title for the single-line
     * InlineEdit: Enter or blur commits, Escape reverts.
     */
    onRename?: (id: string, title: string) => void;
    renameTestId?: (entry: BoardEntry) => string;
    /** Label for the overlaid controls group. */
    actionsLabel?: string;
};

/**
 * One board. The renaming row is LOCAL view state (one at a time, mirroring the
 * transcript's one-editor-at-a-time rule) and never leaks into the store: the
 * committed text goes out through `onRename`, after which the row falls back to
 * the stored title.
 */
export function SessionsBoard({
    heading,
    count,
    entries,
    emptyLabel,
    listTestId,
    emptyTestId,
    entryTestId,
    selectLabel,
    onSelect,
    onDelete,
    deleteLabel = 'Delete entry',
    deleteTestId,
    onRename,
    renameTestId,
    actionsLabel = 'Row actions'
}: SessionsBoardProps) {
    // id of the row whose title is the inline editor, or null when none is.
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const headingCount = count ?? entries.length;

    return (
        <>
            <div className="rail__heading">
                <span className="rail__heading-text">{heading}</span>
                <span className="rail__count">{headingCount}</span>
            </div>

            {entries.length === 0 ? (
                <p className="rail__empty" data-testid={emptyTestId}>
                    {emptyLabel}
                </p>
            ) : (
                <ul className="rail__list" data-testid={listTestId}>
                    {entries.map((entry) => {
                        const renaming = renamingId === entry.id;
                        const selected = entry.selected === true;
                        const disabled = entry.disabled === true;
                        // The two title lines every row shape shares (title + meta).
                        const label = (
                            <>
                                <span className="rail__title">{entry.title}</span>
                                {entry.meta ? <span className="rail__meta">{entry.meta}</span> : null}
                            </>
                        );

                        return (
                            <li
                                key={entry.id}
                                className="rail__entry"
                                data-selected={selected ? 'true' : 'false'}
                                data-testid={entryTestId(entry)}
                            >
                                {/* Sibling slot 1 — the select control. It fills the row
                                    and carries NO nested interactive children. While the
                                    title is being renamed it is replaced by the editor,
                                    so the two never overlap. */}
                                {renaming ? (
                                    <InlineEdit
                                        key="edit"
                                        element="div"
                                        className="rail__edit"
                                        multiline={false}
                                        value={entry.title}
                                        testId={`rename-entry-${entry.id}`}
                                        ariaLabel="Conversation title"
                                        // Rename starts at the end of the title: the
                                        // row affordance is a whole-value rename, not a
                                        // click-inside-the-word transcript edit.
                                        caretOffset={entry.title.length}
                                        onCommit={(text) => {
                                            // Blank/unchanged commits restore the
                                            // original (the oracle's rename rule).
                                            const next = text.trim();
                                            if (next !== '' && next !== entry.title) onRename?.(entry.id, next);
                                            setRenamingId(null);
                                        }}
                                        onCancel={() => setRenamingId(null)}
                                    />
                                ) : onSelect === undefined ? (
                                    <div
                                        className="rail__item rail__item--static"
                                        data-selected={selected ? 'true' : 'false'}
                                        aria-current={selected ? 'true' : undefined}
                                    >
                                        {label}
                                    </div>
                                ) : (
                                    <button
                                        type="button"
                                        className="rail__item"
                                        data-selected={selected ? 'true' : 'false'}
                                        disabled={disabled}
                                        aria-current={selected ? 'true' : undefined}
                                        aria-label={selectLabel(entry)}
                                        // The title words are the rename trigger (the
                                        // oracle renames by clicking the words); a plain
                                        // click still selects, exactly as before.
                                        onDoubleClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
                                            if (onRename === undefined) return;
                                            event.preventDefault();
                                            setRenamingId(entry.id);
                                        }}
                                        onKeyDown={(event: ReactKeyboardEvent<HTMLButtonElement>) => {
                                            if (onRename !== undefined && event.key === 'F2') {
                                                event.preventDefault();
                                                setRenamingId(entry.id);
                                            }
                                        }}
                                        onClick={() => onSelect(entry.id)}
                                    >
                                        {label}
                                    </button>
                                )}

                                {/* Sibling slot 2 — the overlaid controls, absolutely
                                    positioned over the row's top-right corner by
                                    sessions.css: they paint ON TOP of the select
                                    control without ever being inside it. */}
                                {!renaming && (onRename !== undefined || onDelete !== undefined) ? (
                                    <span className="rail__actions" role="group" aria-label={actionsLabel}>
                                        {onRename !== undefined ? (
                                            <button
                                                type="button"
                                                className="rail__ghost"
                                                aria-label={`Rename ${entry.title}`}
                                                title="Rename"
                                                disabled={disabled}
                                                data-testid={renameTestId ? renameTestId(entry) : undefined}
                                                onClick={() => setRenamingId(entry.id)}
                                            >
                                                <EditIcon size={14} />
                                            </button>
                                        ) : null}
                                        {onDelete !== undefined ? (
                                            <button
                                                type="button"
                                                className="rail__ghost rail__ghost--danger"
                                                aria-label={deleteLabel}
                                                title={deleteLabel}
                                                disabled={disabled}
                                                data-testid={deleteTestId ? deleteTestId(entry) : undefined}
                                                onClick={() => onDelete(entry.id)}
                                            >
                                                <CloseIcon size={14} />
                                            </button>
                                        ) : null}
                                    </span>
                                ) : null}
                            </li>
                        );
                    })}
                </ul>
            )}
        </>
    );
}
