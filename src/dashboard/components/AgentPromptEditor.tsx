// AgentPromptEditor — the agent's system-prompt textarea plus its themed resize grip.
//
// BEHAVIOR ORACLE (read-only): src/components/ChatAssistantApp.tsx
//   `AgentPromptTextarea` (native grip disabled)  :575-596
//   height clamps + keyboard step                 :598-605
//   `AgentPromptField` (positioning context)      :607-611
//   `AgentPromptGrip` (the replacement pill)      :613-632
//   `AgentPromptEditor` (drag + keyboard logic)   :634-735
//
// WHAT IT DOES. The browser's own textarea corner is `resize: none`'d away,
// because its chrome cannot be themed (oracle :576-579); in its place sits a small
// pill centred on the field's bottom edge that the operator drags vertically. A
// drag writes CLAMPED pixel heights straight onto the node's inline style — React
// never owns that property, so a re-render cannot reset it (:660-665) — and ArrowUp
// / ArrowDown on the focused grip nudge the same height one line at a time for
// keyboard users (:702-708).
//
// WHY WINDOW LISTENERS RATHER THAN POINTER CAPTURE (oracle :677-680): the grip is
// 4px tall, so the pointer leaves the element mid-drag almost immediately;
// `setPointerCapture` is also unavailable in some environments. The move/up/cancel
// trio is therefore attached to `window` for the duration of the gesture, and the
// teardown ref below guarantees an unmount mid-drag does not leak listeners that
// would write heights into a detached node (:649-656).
//
// JSDOM DEGRADATION (the part a test can actually reach). jsdom reports a
// zero-height box: `getBoundingClientRect().height` and `clientHeight` are both 0,
// which in the oracle made the first drag start from height 0 and clamp straight to
// the floor. Here a zero measurement is treated as "the field is at its minimum",
// which keeps the drag and the keyboard step meaningful in a headless run
// (ArrowDown from a fresh mount lands on MIN + STEP = 120px) and changes nothing in
// a real browser, where the measured height is non-zero and wins.
//
// THE ONE INLINE STYLE: the field's pixel height is per-gesture geometry, exactly
// the case the skin allows inline styles for (see ComposerDeck.tsx:27-29 for the
// same exception). Every other appearance is a class from styles/agents.css.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { TextareaHTMLAttributes } from 'react';

// Height clamps are OUTER pixel heights (oracle :598-603). The floor is ~3 text
// lines at the skin's 14px/1.5 line-height plus the field's padding; the cap keeps
// a long prompt from swallowing the stage column, which scrolls on its own.
export const AGENT_PROMPT_MIN_HEIGHT = 96;
export const AGENT_PROMPT_MAX_HEIGHT = 480;
// Keyboard increment (ArrowDown grows, ArrowUp shrinks): ~one text line (:604-605).
export const AGENT_PROMPT_RESIZE_STEP = 24;

/**
 * Clamp a candidate height into the drag range. Exported so a test pins the two
 * edges exactly: 10 -> 96 (floor), 900 -> 480 (cap), 200 -> 200 (untouched).
 */
export const clampPromptHeight = (next: number): number =>
    Math.min(AGENT_PROMPT_MAX_HEIGHT, Math.max(AGENT_PROMPT_MIN_HEIGHT, next));

/**
 * The height a gesture starts from: the remembered drag height first (so resizes
 * survive re-renders AND stay deterministic where geometry is unavailable — the
 * oracle's own rule, :667-675), else the live box, else the floor in an environment
 * that reports no geometry at all (see the jsdom note above).
 */
export const promptHeightFrom = (element: HTMLTextAreaElement | null, remembered: number | null): number => {
    if (remembered !== null) return remembered;
    if (element === null) return AGENT_PROMPT_MIN_HEIGHT;
    return element.getBoundingClientRect().height || element.clientHeight || AGENT_PROMPT_MIN_HEIGHT;
};

/** Any textarea attribute is forwarded to the field, exactly as in the oracle. */
export type AgentPromptEditorProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export function AgentPromptEditor({ className, ...props }: AgentPromptEditorProps) {
    // The field node (for measuring + applying heights) and the remembered drag
    // height. `heightRef` is a ref, not state: a drag must not re-render the agent
    // workspace on every pointermove frame.
    const fieldRef = useRef<HTMLTextAreaElement | null>(null);
    const heightRef = useRef<number | null>(null);
    // Active-drag flag, the only part of the gesture the CSS needs to see (it drives
    // the grip's opacity through `data-resizing`, replacing the oracle's `active`
    // styledComponent prop — see agents.css `.agent__grip[data-resizing='true']`).
    const [resizing, setResizing] = useState(false);
    // Teardown of the in-flight gesture's window listeners.
    const stopRef = useRef<(() => void) | null>(null);

    useEffect(
        () => () => {
            const finish = stopRef.current;
            if (finish !== null) finish();
        },
        // Empty deps on purpose: the cleanup belongs to the mounted field, and
        // `stopRef` is a create-once ref (same discipline as ChatStage.tsx:294-301).
        []
    );

    /** Clamp, remember, then paint. The remembered value goes first so the next
     *  interaction continues from here rather than re-measuring mid-drag. */
    const applyHeight = useCallback((next: number) => {
        const clamped = clampPromptHeight(next);
        heightRef.current = clamped;
        const element = fieldRef.current;
        if (element !== null) element.style.height = `${clamped}px`;
    }, []);

    const currentHeight = useCallback(
        () => promptHeightFrom(fieldRef.current, heightRef.current),
        []
    );

    /** Pointer drag: window-level move/up/cancel, one delta from the grab point. */
    const onGripPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        setResizing(true);
        const startY = event.clientY;
        const startHeight = currentHeight();
        const move = (moveEvent: PointerEvent) => {
            applyHeight(startHeight + (moveEvent.clientY - startY));
        };
        const finish = () => {
            setResizing(false);
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', finish);
            window.removeEventListener('pointercancel', finish);
            stopRef.current = null;
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', finish);
        window.addEventListener('pointercancel', finish);
        stopRef.current = finish;
    };

    /** Keyboard equivalent of the drag: ArrowDown grows, ArrowUp shrinks, the rest untouched. */
    const onGripKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        applyHeight(currentHeight() + (event.key === 'ArrowDown' ? AGENT_PROMPT_RESIZE_STEP : -AGENT_PROMPT_RESIZE_STEP));
    };

    // The ref callback keeps braces so React 19 never reads a returned value as a
    // ref-cleanup function (the note the oracle carries at :710-712).
    const setField = (element: HTMLTextAreaElement | null) => {
        fieldRef.current = element;
    };

    return (
        <div className="agent__prompt">
            <textarea
                {...props}
                ref={setField}
                // A caller-supplied class ADDS to the field's own, it never replaces
                // it: the grip's geometry is authored against `.agent__prompt-input`.
                className={className ? `agent__prompt-input ${className}` : 'agent__prompt-input'}
            />
            {/* The grip is decorative-but-focusable chrome: `role="separator"` names
                the resize affordance, and the arrows are the keyboard contract. */}
            <div
                className="agent__grip"
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize the system prompt field"
                title="Drag to resize"
                tabIndex={0}
                data-resizing={resizing ? 'true' : 'false'}
                data-testid="agent-prompt-grip"
                onPointerDown={onGripPointerDown}
                onKeyDown={onGripKeyDown}
            />
        </div>
    );
}
