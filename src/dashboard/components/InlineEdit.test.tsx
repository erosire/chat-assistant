// InlineEdit: the contentEditable contract the transcript and the rail share.
//
// Every expectation here is DERIVED FROM THE RULES, not from observed output:
//   - blur commits the DOM text with line structure intact (the oracle's
//     `editableTextContent`, ChatAssistantApp.tsx:1858-1876, exists because raw
//     `textContent` fuses a multi-line edit into one line);
//   - Escape cancels and must never commit (oracle 2198-2203);
//   - Enter commits only in single-line mode (the title rule, oracle 4464-4472);
//   - the caret lands on the clicked word when the engine can resolve the click
//     point, and at the text END when it cannot — jsdom resolves neither
//     `caretRangeFromPoint` nor `caretPositionFromPoint` (oracle 1884-1885, 3141).
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InlineEdit, caretOffsetFromPoint, placeCaretAtOffset, readEditableText } from './InlineEdit';

afterEach(() => {
    cleanup();
});

/** Mount one editor and report the node + the recorded commit/cancel calls. */
function mountEditor(props: Partial<Parameters<typeof InlineEdit>[0]> = {}) {
    const committed: string[] = [];
    const cancelled: number[] = [];
    render(
        <InlineEdit
            value="hello world"
            testId="editor"
            ariaLabel="Edit message"
            onCommit={(text) => committed.push(text)}
            onCancel={() => cancelled.push(1)}
            {...props}
        />
    );
    return { node: screen.getByTestId('editor'), committed, cancelled };
}

describe('readEditableText', () => {
    it('preserves the line structure a browser builds out of block wrappers', () => {
        const host = document.createElement('div');
        // Real editor shape: every line lives in its own <div>/<p>, and a soft
        // break inside one line is a <br>. Raw `textContent` would fuse all four
        // lines into one, which is the bug this helper exists to prevent.
        host.innerHTML = '<div>first</div><div>second</div><div>third<br>fourth</div>';
        expect(readEditableText(host)).toBe('first\nsecond\nthird\nfourth');
    });

    it('drops the trailing empty block a caret leaves behind', () => {
        const host = document.createElement('div');
        host.innerHTML = '<div>kept</div><div><br></div>';
        expect(readEditableText(host)).toBe('kept');
    });
});

describe('caretOffsetFromPoint', () => {
    it('reports null when the engine exposes no point-to-caret API at all', () => {
        // jsdom implements neither API, which is the documented fallback path.
        const host = document.createElement('div');
        host.textContent = 'abcdef';
        expect(caretOffsetFromPoint(10, 10, host)).toBeNull();
    });

    it('sums preceding text nodes when the point resolves to the element itself', () => {
        const original = (document as Document & { caretRangeFromPoint?: unknown }).caretRangeFromPoint;
        const host = document.createElement('div');
        host.innerHTML = 'abc<span>def</span>ghi';
        document.caretRangeFromPoint = (() => {
            const range = document.createRange();
            // Offset 1 == "after the first child" (the text node 'abc').
            range.setStart(host, 1);
            range.setEnd(host, 1);
            return range;
        }) as (x: number, y: number) => Range;
        try {
            expect(caretOffsetFromPoint(4, 8, host)).toBe(3);
        } finally {
            (document as Document & { caretRangeFromPoint?: unknown }).caretRangeFromPoint = original;
        }
    });

    it('returns null for a point outside the element', () => {
        const original = (document as Document & { caretRangeFromPoint?: unknown }).caretRangeFromPoint;
        const host = document.createElement('div');
        host.textContent = 'inside';
        const outside = document.createElement('div');
        outside.textContent = 'outside';
        document.body.append(host, outside);
        document.caretRangeFromPoint = (() => {
            const range = document.createRange();
            range.setStart(outside.firstChild as Node, 2);
            range.setEnd(outside.firstChild as Node, 2);
            return range;
        }) as (x: number, y: number) => Range;
        try {
            expect(caretOffsetFromPoint(1, 1, host)).toBeNull();
        } finally {
            (document as Document & { caretRangeFromPoint?: unknown }).caretRangeFromPoint = original;
            host.remove();
            outside.remove();
        }
    });
});

describe('placeCaretAtOffset', () => {
    it('clamps an offset past the end onto the last text node', () => {
        const host = document.createElement('div');
        host.textContent = 'abc';
        document.body.append(host);
        placeCaretAtOffset(host, 99);
        const selection = window.getSelection();
        expect(selection?.rangeCount).toBe(1);
        const range = selection?.getRangeAt(0);
        expect(range?.startContainer).toBe(host.firstChild);
        expect(range?.startOffset).toBe(3);
        host.remove();
    });
});

describe('InlineEdit', () => {
    it('is the focused contentEditable with a textbox role on mount', () => {
        const { node } = mountEditor();
        expect(node.getAttribute('contenteditable')).toBe('true');
        expect(node.getAttribute('role')).toBe('textbox');
        expect(node.getAttribute('aria-multiline')).toBe('true');
        expect(node.getAttribute('data-editing')).toBe('true');
        expect(document.activeElement).toBe(node);
    });

    it('commits the newline-preserving text on blur', () => {
        const { node, committed, cancelled } = mountEditor();
        // A browser typing Enter inside a pre-wrap editor puts every line in its
        // own block wrapper; the commit must keep the break.
        node.innerHTML = '<div>line one</div><div>line two</div>';
        fireEvent.blur(node);
        expect(committed).toEqual(['line one\nline two']);
        expect(cancelled).toEqual([]);
    });

    it('cancels on Escape without committing, and stays cancelled through the blur that follows', () => {
        const { node, committed, cancelled } = mountEditor();
        node.textContent = 'typed but abandoned';
        fireEvent.keyDown(node, { key: 'Escape' });
        expect(cancelled).toEqual([1]);
        expect(committed).toEqual([]);
        // The node is still mounted here (the caller owns the remount), so a real
        // blur fires right after the key: it must NOT smuggle a commit through.
        fireEvent.blur(node);
        expect(committed).toEqual([]);
        expect(cancelled).toEqual([1]);
    });

    it('keeps Enter as a newline in multiline mode', () => {
        const { node, committed } = mountEditor();
        fireEvent.keyDown(node, { key: 'Enter', shiftKey: false });
        expect(committed).toEqual([]);
    });

    it('commits on Enter in single-line mode (the rename/title rule)', () => {
        const { node, committed } = mountEditor({ multiline: false, ariaLabel: 'Conversation title' });
        node.textContent = 'Renamed chat';
        // fireEvent returns false once the handler cancelled the default, which is
        // the part that stops the editor inserting a newline into a title.
        expect(fireEvent.keyDown(node, { key: 'Enter', shiftKey: false })).toBe(false);
        expect(committed).toEqual(['Renamed chat']);
        expect(node.getAttribute('aria-multiline')).toBe('false');
    });

    it('does not cancel Enter in multiline mode (bubbles keep their newlines)', () => {
        const { node, committed } = mountEditor();
        expect(fireEvent.keyDown(node, { key: 'Enter', shiftKey: false })).toBe(true);
        expect(committed).toEqual([]);
    });

    it('ignores an IME-confirming Enter in single-line mode', () => {
        const { node, committed } = mountEditor({ multiline: false });
        // `isComposing` is set on the native event, exactly as the composer's
        // textarea handler reads it.
        fireEvent.keyDown(node, { key: 'Enter', shiftKey: false, isComposing: true });
        expect(committed).toEqual([]);
    });

    it('fires exactly one action even when Escape and blur both land', () => {
        const { node, committed, cancelled } = mountEditor();
        act(() => {
            fireEvent.keyDown(node, { key: 'Escape' });
            fireEvent.blur(node);
            fireEvent.blur(node);
        });
        expect(cancelled).toEqual([1]);
        expect(committed).toEqual([]);
    });
});
