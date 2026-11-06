// MessageTurn — one rendered turn: header row, bubble, trailing controls.
//
// BEHAVIOR ORACLE (read-only): src/components/ChatAssistantApp.tsx
//   `renderMessages` 2007-2310 is the source of every rule reproduced here:
//   - the attribution label in the row ABOVE the bubble IS the collapse toggle
//     ("no chevron glyph ever renders"), and the label text is the producing
//     model for an assistant turn that records one, otherwise the literal
//     speaker ("user" / "system");
//   - a collapsed turn shows the label plus a one-line FIRST-LINE preview
//     stacked BELOW it (never inline); user stacks stay right-aligned;
//   - the delete cross sits on the right of the header row and never renders for
//     a system turn (the system prompt cannot be removed by message delete);
//   - the copy/fork strip under the bubble exists only while the turn is
//     expanded, and greys out + natively disables while an inline edit owns the
//     record — it never disappears during streaming;
//   - `controlsShouldFloat` (2401-2402) gates the bottom-sticky strip so the
//     floating row can never travel above its natural slot and cover the turn's
//     own header (its delete "x").
//
// TEXT IS PLAIN TEXT. The body renders as one text node with
// `white-space: pre-wrap; overflow-wrap: anywhere` (transcript.css). There is no
// markdown pipeline here or in the oracle — a reply's characters are exactly what
// appears, which is also what makes the contentEditable edit round-trip lossless.
//
// EDIT STATE IS LIFTED, exactly like the oracle's `MessageListOptions`
// (1806-1856): the parent (TranscriptStream) owns `editingIndex`, because "one
// editor at a time" is a property of the LIST, not of a row. `chat.turns[].editing`
// is the store's half of the same flag — contract.ts publishes no
// `chat.message.edit.begin/cancel` command, so a click opens the editor locally
// and a store-driven edit (from the aside, say) force-opens it through the cell.
// The commit itself is the contract's auto-save-on-blur command, `chat.message.update`.
//
// STICKY GATE: the measurement lives HERE because the strip is this component's
// own DOM. It reads the nearest `[data-testid="transcript"]` scroller (the
// stage's single scroll container) on scroll/resize and flips `floating`. Only a
// class changes — `position: sticky; bottom: 0` in transcript.css IS the pin —
// so the float needs no inline style object.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import type { ChatRole, ChatTurn } from '../contract';
import {
    CHAT_MESSAGE_COPY_COMMAND,
    CHAT_MESSAGE_DELETE_COMMAND,
    CHAT_MESSAGE_FORK_COMMAND,
    CHAT_MESSAGE_ROLE_COMMAND,
    CHAT_MESSAGE_UPDATE_COMMAND,
    CHAT_TURN_TOGGLE_COMMAND
} from '../contract';
import { useWorkbench } from '../workbench';
import { InlineEdit, caretOffsetFromPoint } from './InlineEdit';
import { ChevronDownIcon, ChevronUpIcon, CloseIcon, CopyIcon, ForkIcon, SwitchIcon } from '../../icons';

/**
 * Half-pixel tolerance for sub-pixel scroll geometry (browser zoom,
 * devicePixelRatio): boundary equality must not flicker the floating mode on and
 * off across a 0.5px line. Oracle 2368-2371.
 */
export const CONTROLS_FLOAT_EPSILON = 0.5;

/**
 * Pure sticky-gate predicate — the anti-"dark line across the x" rule. The strip
 * may FLOAT (pin to the list's visible bottom edge) only while BOTH hold:
 *   1. its turn's END is not in view — the natural strip slot, flush with the
 *      turn's bottom, lies strictly below the pin line; and
 *   2. the PINNED position would not collide with the turn's own header row —
 *      pin top (= pin line - strip height) stays at or below the header's bottom.
 * Without clause 2 raw CSS sticky also engages while the whole turn is BELOW the
 * fold, and the containing-block clamp drags the strip onto the turn's top edge,
 * covering the delete "x" (oracle 2390-2399, geometry measured in real Chrome).
 * Verbatim port of oracle 2401-2402.
 */
export const controlsShouldFloat = (
    turnBottom: number,
    headerBottom: number,
    pinBottom: number,
    stripHeight: number
): boolean =>
    turnBottom - pinBottom > CONTROLS_FLOAT_EPSILON &&
    pinBottom - stripHeight >= headerBottom - CONTROLS_FLOAT_EPSILON;

/** The only roles the switch affordance flips between (system is immutable). */
export const nextRole = (role: ChatRole): ChatRole => (role === 'user' ? 'assistant' : 'user');

/**
 * The measured bottom-sticky gate for ONE trailing-controls strip.
 *
 * Shared by `MessageTurn` and the system-prompt draft row in TranscriptStream
 * (the oracle treats that row as turn index -1 for exactly this purpose, see
 * ChatAssistantApp.tsx:2991 and 4982-5020). Returns the live `floating` verdict
 * and keeps it fresh across scroll, resize and any geometry-shifting commit.
 *
 * The verdict never reads the STRIP's own live position — only its height —
 * because while floating, the strip's rect IS the pinned rect and would
 * oscillate the gate. Sticky positioning preserves the strip's flow space, so
 * flipping the mode changes none of the inputs: no feedback loop (oracle
 * 2960-2978). Environments with no measurable geometry (jsdom: every rect is 0)
 * land on "anchored" deterministically.
 */
export function useStickyStrip(
    turnRef: { current: HTMLElement | null },
    stripRef: { current: HTMLElement | null },
    revision: unknown = null
): boolean {
    const [floating, setFloating] = useState(false);

    const sync = useCallback(() => {
        const turnNode = turnRef.current;
        const stripNode = stripRef.current;
        // The stage owns the one scroll container; measure against whatever
        // scrollable ancestor that turned out to be (null in isolation).
        const list = turnNode?.closest<HTMLElement>('[data-testid="transcript"]') ?? null;
        if (turnNode === null || stripNode === null || list === null) return;
        // The header row (attribution label + delete "x") is always the turn's
        // FIRST rendered child, so it needs no testid of its own (oracle 2993).
        const header = turnNode.firstElementChild;
        if (header === null) return;
        const listRect = list.getBoundingClientRect();
        // Sticky offsets resolve against the scrollport's PADDING box, so the pin
        // line is the list's bottom PADDING edge (oracle 2966-2989).
        const pinBottom = listRect.bottom - (Number.parseFloat(window.getComputedStyle(list).paddingBottom) || 0);
        const floats = controlsShouldFloat(
            turnNode.getBoundingClientRect().bottom,
            header.getBoundingClientRect().bottom,
            pinBottom,
            stripNode.getBoundingClientRect().height
        );
        // Guarded write: this runs from a scroll listener, and an unguarded
        // setState would re-render the row on every scroll event.
        setFloating((previous) => (previous === floats ? previous : floats));
        // `revision` re-measures after commits that move geometry without a
        // scroll event (collapse, a record swap, a streamed token).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [revision]);

    // Scroll + resize drive the gate; the effect re-attaches whenever the strip
    // mounts/unmounts, and measures once per commit.
    useEffect(() => {
        const list = turnRef.current?.closest<HTMLElement>('[data-testid="transcript"]') ?? null;
        list?.addEventListener('scroll', sync, { passive: true });
        window.addEventListener('resize', sync);
        sync();
        return () => {
            list?.removeEventListener('scroll', sync);
            window.removeEventListener('resize', sync);
        };
    }, [sync]);

    return floating;
}

export type MessageTurnProps = {
    turn: ChatTurn;
    /** "base (provider)" label for a producing model id; '' resolves to ''. */
    labelFor: (modelId: string) => string;
    /**
     * This row is the open editor. `TranscriptStream` resolves it as
     * `turn.editing || editingIndex === turn.index`, i.e. the store's half
     * (`chat.editingIndex` feeds `ChatTurn.editing`, contract.ts:312-320) OR the
     * cell write this surface just made, which is the same truth read back after
     * the store has derived its view model. A row never owns the one-editor rule
     * by itself, so the flag arrives here rather than living in local state.
     */
    editing?: boolean;
    /** Character offset captured from the opening click; null = caret at end. */
    caretOffset?: number | null;
    /**
     * True while ANY inline edit owns the record: every turn's mutation controls
     * stay rendered but greyed + natively disabled (one edit at a time).
     */
    anyEditing?: boolean;
    /**
     * False while a history-rewriting flow owns the record (`chat.status ===
     * 'saving'`): the copy/fork strip and the delete cross disappear, exactly
     * like the oracle's `showControls === false` during deletion/persistence.
     * Waiting/streaming never clears this — generation must not make the UI look
     * frozen (oracle 2013-2019, 4397-4405).
     */
    showControls?: boolean;
    /**
     * Section-local scroll: true docks this turn's TOP edge on the list's top
     * padding line, false lands its BOTTOM edge on the bottom padding line.
     * Owned by ChatStage (it owns the scroll container); omit = no chevrons.
     */
    onJump?: (testId: string, toTop: boolean) => void;
    /** Click on an expanded bubble's words: the parent opens this row's editor. */
    onEditStart?: (index: number, caretOffset: number | null) => void;
    /** Escape (or a completed commit): the parent drops its editing index. */
    onEditEnd?: () => void;
};

export function MessageTurn({
    turn,
    labelFor,
    editing: edited = false,
    caretOffset = null,
    anyEditing = false,
    showControls = true,
    onJump,
    onEditStart,
    onEditEnd
}: MessageTurnProps) {
    const instance = useWorkbench();
    const { index, message, role, collapsed, model } = turn;
    // The host's flag OR the store's flag: either half opens the editor, so a
    // store-driven edit (from the aside) and a click in this list behave alike.
    const editing = edited || turn.editing;

    // "Controls grey while an edit runs" — the edited row plus every other row.
    const locked = anyEditing;
    // While THIS row is the editor its collapse toggle is inert (folding would
    // unmount the live editor) — oracle 2138-2141.
    const toggleDisabled = editing;
    const greyed = locked || !showControls;

    const expanded = !collapsed;
    const controlsVisible = expanded && showControls;

    // ——— measured sticky gate —————————————————————————————————————————————
    const turnRef = useRef<HTMLLIElement | null>(null);
    const stripRef = useRef<HTMLDivElement | null>(null);
    // Re-measure whenever geometry could have moved without a scroll event.
    const floating = useStickyStrip(turnRef, stripRef, `${collapsed}:${message.content.length}:${editing}`);

    // ——— actions ——————————————————————————————————————————————————————————
    const toggle = () => instance.execute<number>(CHAT_TURN_TOGGLE_COMMAND, index);

    const openEditor = (event: MouseEvent<HTMLElement>) => {
        if (!canEdit) return;
        // The click POINT becomes a character offset BEFORE the remount: the
        // bubble only turns contentEditable after the click, so the browser never
        // places the caret natively (oracle 2087-2098).
        const offset = caretOffsetFromPoint(event.clientX, event.clientY, event.currentTarget);
        onEditStart?.(index, offset);
    };

    const commit = (text: string) => {
        // Blank/unchanged commits write nothing: the oracle's `commitEdit`
        // restores the original instead of issuing a history rewrite.
        if (text !== message.content) {
            instance.execute(CHAT_MESSAGE_UPDATE_COMMAND, { index, content: text });
        }
        onEditEnd?.();
    };

    // Attribution: the producing model's display label for an assistant turn that
    // records one, the literal role otherwise (oracle 2109-2118). A turn with an
    // empty `model` (user/system rows, older records) never renders '' as a label.
    const attributed = role === 'assistant' && model !== '';
    const speakerLabel = attributed ? labelFor(model) : role;
    const alignRight = role === 'user';
    // The bubble is only a click target while an edit could start (the affordance
    // and the cursor hint must agree — oracle 2090-2102).
    const canEdit = expanded && showControls && !locked && onEditStart !== undefined;

    return (
        <li
            ref={turnRef}
            className={`msg msg--${role}`}
            data-collapsed={collapsed ? 'true' : 'false'}
            data-editing={editing ? 'true' : 'false'}
            data-testid={`message-turn-${index}`}
        >
            {/* Header row: ALWAYS rendered (even while edited), and always the
                turn's FIRST child — the sticky gate measures its bottom edge. */}
            <div className="msg__head">
                <div className="msg__lead" data-align={alignRight ? 'right' : 'left'}>
                    <button
                        type="button"
                        className="msg__label"
                        disabled={toggleDisabled}
                        aria-expanded={expanded}
                        aria-label={collapsed ? 'Expand message' : 'Collapse message'}
                        title={collapsed ? 'Expand message' : 'Collapse message'}
                        data-testid={`collapse-message-${index}`}
                        onClick={toggle}
                    >
                        {/* `message-model-N` marks the producing-model attribution;
                            every other row is `message-label-N` (oracle 2148-2157). */}
                        <span
                            className="msg__role"
                            data-testid={attributed ? `message-model-${index}` : `message-label-${index}`}
                        >
                            {speakerLabel}
                        </span>
                    </button>
                    {/* The role switch survives collapsing: the label is the
                        visible handle in that state (oracle 2070-2086). System
                        prompts are intentionally immutable through it, and a
                        history-rewriting save withdraws it with the rest of the
                        chrome (`showControls === false`). */}
                    {role !== 'system' && showControls ? (
                        <button
                            type="button"
                            className="msg__ghost"
                            disabled={greyed}
                            aria-label={`Switch ${role} message to ${nextRole(role)}`}
                            title={`Switch ${role} message to ${nextRole(role)}`}
                            data-testid={`switch-message-${index}`}
                            onClick={() => instance.execute(CHAT_MESSAGE_ROLE_COMMAND, { index, role: nextRole(role) })}
                        >
                            <SwitchIcon size={14} />
                        </button>
                    ) : null}
                    {collapsed ? (
                        // The collapsed "message": the first line stacked BELOW
                        // the label; clicking it expands the turn (there is no
                        // chevron to click).
                        <button
                            type="button"
                            className="msg__preview"
                            data-align={alignRight ? 'right' : 'left'}
                            title="Expand message"
                            data-testid={`message-preview-${index}`}
                            onClick={toggle}
                        >
                            {message.content.split('\n')[0]}
                        </button>
                    ) : null}
                </div>
                {/* Delete cross: hidden while the turn is COLLAPSED, exactly like the
                    copy/fork strip — "collapsed turns hide the bubble AND its
                    copy/delete controls" (oracle 1997-1999, 2020-2023) — and it never
                    renders for a system turn: the chat's prompt cannot be deleted. */}
                {controlsVisible && role !== 'system' ? (
                    <button
                        type="button"
                        className="msg__ghost msg__ghost--danger"
                        disabled={greyed}
                        aria-label="Delete message"
                        title="Delete message"
                        data-testid={`delete-message-${index}`}
                        onClick={() => instance.execute<number>(CHAT_MESSAGE_DELETE_COMMAND, index)}
                    >
                        <CloseIcon size={14} />
                    </button>
                ) : null}
            </div>

            {/* Body: one text node, plain text. The key flips between 'view' and
                'edit' so abandoning an edit REMOUNTS the bubble — React never
                rewrites untouched contentEditable DOM, and only a remount
                reliably restores the original text (oracle 2178-2185). */}
            {expanded ? (
                editing ? (
                    <InlineEdit
                        key="edit"
                        element="div"
                        className="msg__text msg__text--edit"
                        value={message.content}
                        caretOffset={caretOffset}
                        testId={`message-content-${index}`}
                        ariaLabel="Edit message"
                        onCommit={commit}
                        onCancel={onEditEnd ?? (() => {})}
                    />
                ) : (
                    <div
                        key="view"
                        className="msg__text"
                        role={canEdit ? 'button' : undefined}
                        tabIndex={canEdit ? 0 : undefined}
                        title={canEdit ? 'Click to edit' : undefined}
                        data-editable={canEdit ? 'true' : 'false'}
                        data-testid={`message-content-${index}`}
                        onClick={openEditor}
                        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                            // Keyboard parity for the click-to-edit affordance.
                            if (event.key !== 'Enter' && event.key !== ' ') return;
                            event.preventDefault();
                            if (canEdit) onEditStart?.(index, null);
                        }}
                    >
                        {message.content}
                    </div>
                )
            ) : null}

            {/* Trailing controls: the section chevrons (left edge) and copy/fork
                (glued right). The strip is the turn's LAST child, so its natural
                slot is flush with the turn's bottom edge — the invariant
                `controlsShouldFloat` measures against. */}
            {controlsVisible ? (
                <div
                    ref={stripRef}
                    className={floating ? 'msg__controls is-floating' : 'msg__controls'}
                    data-floating={floating ? 'true' : 'false'}
                    data-testid={`turn-controls-${index}`}
                >
                    <span className="msg__jump" role="group" aria-label="Scroll this section">
                        {onJump ? (
                            <>
                                <button
                                    type="button"
                                    className="msg__ghost"
                                    disabled={greyed}
                                    aria-label="Scroll to section top"
                                    title="Scroll to section top"
                                    data-testid={`turn-jump-top-${index}`}
                                    onClick={() => onJump(`message-turn-${index}`, true)}
                                >
                                    <ChevronUpIcon size={14} />
                                </button>
                                <button
                                    type="button"
                                    className="msg__ghost"
                                    disabled={greyed}
                                    aria-label="Scroll to section bottom"
                                    title="Scroll to section bottom"
                                    data-testid={`turn-jump-bottom-${index}`}
                                    onClick={() => onJump(`message-turn-${index}`, false)}
                                >
                                    <ChevronDownIcon size={14} />
                                </button>
                            </>
                        ) : null}
                    </span>
                    <span className="msg__actions" role="group" aria-label="Message actions">
                        <button
                            type="button"
                            className="msg__ghost"
                            disabled={greyed}
                            aria-label="Copy message"
                            title="Copy message"
                            data-testid={`copy-message-${index}`}
                            onClick={() => instance.execute<number>(CHAT_MESSAGE_COPY_COMMAND, index)}
                        >
                            <CopyIcon size={14} />
                        </button>
                        {/* Forking spans the persisted interval from this message;
                            a system prompt has no interval to fork. */}
                        {role !== 'system' ? (
                            <button
                                type="button"
                                className="msg__ghost"
                                disabled={greyed}
                                aria-label="Fork conversation from this message"
                                title="Fork conversation from this message"
                                data-testid={`fork-message-${index}`}
                                onClick={() => instance.execute<number, Promise<string>>(CHAT_MESSAGE_FORK_COMMAND, index)}
                            >
                                <ForkIcon size={14} />
                            </button>
                        ) : null}
                    </span>
                </div>
            ) : null}
        </li>
    );
}
