// Inline contentEditable editor for the workstation skin.
//
// BEHAVIOR ORACLE (read-only, do not edit): src/components/ChatAssistantApp.tsx
//   - `editableTextContent`  (ChatAssistantApp.tsx:1864-1876) -> readEditableText
//   - `textOffsetFromPoint`  (ChatAssistantApp.tsx:1886-1931) -> caretOffsetFromPoint
//   - `placeCaretAtOffset`   (ChatAssistantApp.tsx:1937-1964) -> placeCaretAtOffset
//   - the keyed 'view'/'edit' bubble remount + the auto-focus effect
//     (ChatAssistantApp.tsx:2178-2212, 3134-3167)
//
// WHY contentEditable (and not a textarea swap): the oracle's rule is that the
// words THEMSELVES are the edit trigger — the rendered bubble becomes the editor
// in place, with the caret restored onto the CLICKED WORD. A textarea cannot
// carry that affordance, and React cannot revert a mutated contentEditable DOM
// node through reconciliation, which is why every caller keys the element between
// 'view' and 'edit' so abandoning an edit REMOUNTS it (see the `key` note below).
//
// COMMIT RULES (ported verbatim from the oracle's bubble/title editors):
//   - BLUR commits the DOM text (newline preserving) — the auto-save-on-blur rule;
//   - ESCAPE cancels and must NOT commit (the oracle relies on the keyed remount;
//     `settledRef` here also blocks the blur that follows a programmatic cancel);
//   - Enter commits ONLY in single-line mode (`multiline === false`) — that is the
//     title/rename rule from the oracle's header h1 (ChatAssistantApp.tsx:4464-4472);
//     in multiline mode Enter keeps inserting a newline like the bubbles do.
//
// JSDOM DEGRADATION (the tests run there): jsdom implements NEITHER
// `document.caretRangeFromPoint` NOR `document.caretPositionFromPoint`, so
// `caretOffsetFromPoint` returns null and the caret lands at the TEXT END (the
// oracle's documented fallback, ChatAssistantApp.tsx:3141). `focus()` is called
// with `preventScroll: true` (load-bearing: default focus scrolls every
// scrollable ancestor, which made long chats jump — oracle 3142-3150).
import { useEffect, useRef } from 'react';
import type { ElementType, KeyboardEvent as ReactKeyboardEvent, FocusEvent as ReactFocusEvent } from 'react';

// ——— DOM text helpers (exported: the callers use them to capture the click) ———

/**
 * Read a contentEditable subtree as plain text WITHOUT losing line structure.
 * Browsers split lines with <div>/<p> wrappers and <br> breaks; raw
 * `textContent` concatenates the fragments with no separator, which would fuse a
 * multi-line edit into one line. Trailing newlines are trimmed (a trailing empty
 * <div> is a caret artifact, not content). Verbatim port of the oracle helper.
 */
export const readEditableText = (element: HTMLElement): string => {
    const walk = (node: Node): string => {
        if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? '';
        if (node.nodeType !== Node.ELEMENT_NODE) return '';
        const tag = (node as HTMLElement).tagName;
        if (tag === 'BR') return '\n';
        const inner = Array.from(node.childNodes).map(walk).join('');
        // Block wrappers BELOW the editor root each own a line.
        if (node !== element && (tag === 'DIV' || tag === 'P')) return `${inner}\n`;
        return inner;
    };
    return Array.from(element.childNodes).map(walk).join('').replace(/\n+$/, '');
};

/**
 * Translate a CLICK POINT (viewport coordinates) into a plain character offset
 * inside the clicked element's text, so the editor remount can restore the caret
 * onto the clicked word. `caretRangeFromPoint` is the Chrome/Safari spelling,
 * `caretPositionFromPoint` the Firefox one; NEITHER exists in jsdom, which is
 * exactly the null case the caller maps to "caret at end". Verbatim port.
 */
export const caretOffsetFromPoint = (x: number, y: number, element: HTMLElement): number | null => {
    let pointNode: Node | null = null;
    let pointOffset = 0;
    const rangeFromPoint = (document as Document & {
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
    }).caretRangeFromPoint;
    const positionFromPoint = (document as Document & {
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node | null; offset: number } | null;
    }).caretPositionFromPoint;

    if (typeof rangeFromPoint === 'function') {
        const range = rangeFromPoint.call(document, x, y);
        if (!range) return null;
        pointNode = range.startContainer;
        pointOffset = range.startOffset;
    } else if (typeof positionFromPoint === 'function') {
        const position = positionFromPoint.call(document, x, y);
        if (!position) return null;
        pointNode = position.offsetNode;
        pointOffset = position.offset;
    } else {
        // jsdom / engines without either API: the caller falls back to the end.
        return null;
    }

    if (pointNode === null || !element.contains(pointNode)) return null;
    // Resolved to the element itself (click past the last glyph): the offset
    // counts CHILD NODES, so sum the text lengths of the preceding ones.
    if (pointNode === element) {
        let total = 0;
        Array.from(element.childNodes).slice(0, pointOffset).forEach((child) => {
            total += (child.textContent ?? '').length;
        });
        return total;
    }
    // Resolved inside a text node: sum every preceding text node's length.
    let total = 0;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    while (current !== null) {
        if (current === pointNode) return total + pointOffset;
        total += (current.textContent ?? '').length;
        current = walker.nextNode();
    }
    return total;
};

/**
 * Collapse the caret at a character offset inside a freshly editable element.
 * Offsets past the text length clamp to the end; an empty element focuses at its
 * single possible position. Verbatim port of the oracle helper.
 */
export const placeCaretAtOffset = (element: HTMLElement, charOffset: number): void => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let remaining = charOffset;
    let node = walker.nextNode();
    let lastTextNode: Node | null = null;
    while (node !== null) {
        const length = (node.textContent ?? '').length;
        if (remaining <= length) {
            range.setStart(node, remaining);
            range.collapse(true);
            break;
        }
        remaining -= length;
        lastTextNode = node;
        node = walker.nextNode();
    }
    if (node === null) {
        if (lastTextNode !== null) range.setStart(lastTextNode, (lastTextNode.textContent ?? '').length);
        else range.setStart(element, 0);
        range.collapse(true);
    }
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
};

// ——— The editor ———————————————————————————————————————————————————————————————

export type InlineEditProps = {
    /** Text the editor starts with (the persisted value, rendered as raw text). */
    value: string;
    /** Stable hook the tests and the focus effect use to find this editor. */
    testId: string;
    /** Accessible name of the editable region (role="textbox"). */
    ariaLabel: string;
    /** Element to render; the skin styles `.msg__edit`/`.rail__edit` for it. */
    element?: ElementType;
    /** Presentation class supplied by the area stylesheet (never a style object). */
    className?: string;
    /**
     * true  -> multiline (bubbles, system prompt): Enter inserts a newline,
     *          only blur commits.
     * false -> single line (conversation title / rename row): Enter commits and
     *          blurs, exactly like the oracle's header h1.
     */
    multiline?: boolean;
    /**
     * Character offset captured from the opening click (see
     * `caretOffsetFromPoint`). null/undefined = unresolvable click point, which
     * places the caret at the text end (the oracle's documented fallback).
     */
    caretOffset?: number | null;
    /** Fired once, with the newline-preserving DOM text, on blur (or on Enter). */
    onCommit: (text: string) => void;
    /** Fired once on Escape. The caller owns the keyed remount that reverts DOM. */
    onCancel: () => void;
};

/**
 * One mounted editor instance. It is ALWAYS the `key="edit"` half of a
 * view/edit pair: mounting it focuses the node (preventScroll) and restores the
 * caret; unmounting it never commits. Exactly one commit/cancel action ever
 * fires per instance (`settledRef`), because the browser's blur lands after the
 * Escape handler within the same interaction.
 */
export function InlineEdit({
    value,
    testId,
    ariaLabel,
    element: Element = 'div' as ElementType,
    className,
    multiline = true,
    caretOffset,
    onCommit,
    onCancel
}: InlineEditProps) {
    const nodeRef = useRef<HTMLElement | null>(null);
    // 'commit' | 'cancel' | null — makes the blur handler idempotent.
    const settledRef = useRef<'commit' | 'cancel' | null>(null);

    // Focus + caret restore run AFTER the remount commit, so the node is the
    // fresh contentEditable element rather than the previous view node.
    useEffect(() => {
        const node = nodeRef.current;
        if (node === null) return;
        node.focus({ preventScroll: true });
        // Number.MAX_SAFE_INTEGER clamps past the end -> caret at the text end.
        placeCaretAtOffset(node, caretOffset ?? Number.MAX_SAFE_INTEGER);
        // Deps are intentionally the mount identity: re-running on every value
        // write would yank the caret while the operator types.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const commit = () => {
        if (settledRef.current !== null) return;
        settledRef.current = 'commit';
        const node = nodeRef.current;
        onCommit(node === null ? value : readEditableText(node));
    };

    const cancel = () => {
        if (settledRef.current !== null) return;
        settledRef.current = 'cancel';
        onCancel();
    };

    const handleBlur = (_event: ReactFocusEvent<HTMLElement>) => {
        // Blur is the save trigger (auto-save on blur), unless Escape already
        // settled this instance.
        commit();
    };

    const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            cancel();
            return;
        }
        if (event.key === 'Enter' && !event.shiftKey && !multiline) {
            // Single-line rule: Enter commits the title and leaves the editor.
            // The IME guard matters here too — confirming a composed candidate
            // also fires Enter, and that must not submit a half-typed title.
            if ((event.nativeEvent as KeyboardEvent).isComposing) return;
            event.preventDefault();
            commit();
            nodeRef.current?.blur();
        }
    };

    return (
        <Element
            ref={nodeRef as never}
            role="textbox"
            aria-multiline={multiline ? 'true' : 'false'}
            aria-label={ariaLabel}
            contentEditable
            suppressContentEditableWarning
            spellCheck={false}
            className={className}
            data-editing="true"
            data-testid={testId}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
        >
            {value}
        </Element>
    );
}
