// ComposerDeck — the composer column: [Agents][Model] line, the auto-growing
// textarea with the docked voice mic and focus-gated send arrow, and the token
// usage line.
//
// BEHAVIOR ORACLE (read-only): src/components/ChatAssistantApp.tsx
//   - `resizeMessageInput` border-box height math   2421-2439
//   - Enter-to-send / Shift+Enter-newline / IME gate  5179-5192
//   - focus-gated send arrow + focus-within rules    5081-5090, 5222-5241
//   - voice mic docked left, always visible          5205-5221
//   - `Total tokens: N` usage line                   5169-5171
//   - the picker row above the input                 5093-5168
//
// THE HEIGHT MATH (the part that is easy to get wrong): the field is
// `box-sizing: border-box` but `scrollHeight` EXCLUDES borders, so every
// measurement adds the 1px top + 1px bottom frame back. Without it a one-row box
// comes out 2px short, the line overflows the content area, and `overflowY: auto`
// delivers a jittery 2px scrollbar. `rows={1}` is what makes the transient
// `height: 'auto'` measurement a genuine ONE-row box instead of the browser's
// two-row textarea default — the pre-fix empty composer locked at two rows.
//
// KEYBOARD RULE (oracle 123-126, 5179-5192): DESKTOP (md+) Enter submits and the
// newline is suppressed; Shift+Enter keeps the newline; MOBILE (<md) Enter ALWAYS
// inserts a newline so the on-screen keyboard's return key only grows the draft —
// submission stays on the send button. `isComposing` is checked FIRST because
// confirming an IME candidate (e.g. Japanese input) also fires Enter.
//
// THE ONE INLINE STYLE: the textarea's pixel height is dynamic geometry the
// oracle genuinely measures per keystroke, which is exactly the case the skin
// allows inline styles for. Everything else is a class from composer.css.
//
// THE FOCUS COMMAND: `chat.composer.focus` is implemented by the chat core plugin
// as a direct focus of `[data-testid="composer-input"]` (see
// src/dashboard/plugins/transcript.ts), so this component's job is to put THAT id
// on the field — which it does — and to let the resulting focus event arm the
// send arrow through the form's onFocus below.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FocusEvent, FormEvent, KeyboardEvent } from 'react';
import {
    CHAT_DRAFT_SET_COMMAND,
    CHAT_DRAFT_STATE,
    CHAT_MESSAGE_CANCEL_COMMAND,
    CHAT_MESSAGE_SEND_COMMAND,
    CHAT_STATUS_STATE,
    CHAT_USAGE_STATE,
    type ChatStatus,
    type ChatUsage
} from '../contract';
import { useDashboardValue } from '../state-hooks';
import { useWorkbench } from '../workbench';
import { ModelPicker } from './ModelPicker';
import { VoiceButton } from './VoiceButton';
// The md gate (900px) is owned by the chat core's viewport seam, so the composer's
// Enter-to-send rule and the rail's drawer cannot drift to different numbers.
import { isDesktopViewport } from '../viewport';
import { ChevronRightIcon, CloseIcon } from '../../icons';

// Vertical border thickness of the field (1px top + 1px bottom, matching the
// authored `border: 1px solid` in composer.css). A CONSTANT, not a computed read:
// jsdom does not expand the `border` shorthand, so a computed read would give the
// tests different math than the browser.
const FIELD_VERTICAL_BORDER = 2;

// Growth cap in rows: eight rows of text, then the field scrolls internally.
const MAX_ROWS = 8;

// Fallback line box (px) when the environment reports no usable line-height
// (jsdom's empty computed style). 14px text at the skin's 1.5 line-height.
const FALLBACK_LINE_HEIGHT = 22.4;

/**
 * Resize the textarea from its content height, floor at one row, cap at eight.
 * Heights are OUTER (border-box): `scrollHeight + borders`, floored at the
 * one-row outer height. Port of the oracle's `resizeMessageInput`.
 */
export const resizeComposerField = (element: HTMLTextAreaElement): void => {
    element.style.height = 'auto';
    const computed = window.getComputedStyle(element);
    const lineHeight = Number.parseFloat(computed.lineHeight) || FALLBACK_LINE_HEIGHT;
    const verticalPadding =
        (Number.parseFloat(computed.paddingTop) || 0) + (Number.parseFloat(computed.paddingBottom) || 0);
    const oneRowHeight = lineHeight + verticalPadding + FIELD_VERTICAL_BORDER;
    const maxHeight = lineHeight * MAX_ROWS + verticalPadding + FIELD_VERTICAL_BORDER;
    const contentHeight = Math.max(element.scrollHeight + FIELD_VERTICAL_BORDER, oneRowHeight);
    element.style.height = `${Math.min(contentHeight, maxHeight)}px`;
};

export function ComposerDeck() {
    const instance = useWorkbench();
    const draft = useDashboardValue<string>(CHAT_DRAFT_STATE);
    const status = useDashboardValue<ChatStatus>(CHAT_STATUS_STATE);
    const usage = useDashboardValue<ChatUsage | null>(CHAT_USAGE_STATE);

    const fieldRef = useRef<HTMLTextAreaElement | null>(null);
    // Focus-within emulation: the send arrow exists only while focus is inside
    // the composer (oracle 5081-5090). React has no :focus-within, so the form's
    // onFocus/onBlur pair owns it — blur only counts when focus LEAVES the form
    // entirely, because clicking the arrow blurs the input first and would
    // otherwise unmount the button before its click lands.
    const [focused, setFocused] = useState(false);

    const sending = status === 'sending';
    const canSend = draft.trim().length > 0;

    // ——— effects ——————————————————————————————————————————————————————————
    // Keep the editor in sync with programmatic writes (a send clears the draft,
    // a voice session fills it, chat switching restores it) — the change handler
    // already did the same math for typed text. Port of oracle 2905-2910.
    useEffect(() => {
        const field = fieldRef.current;
        if (field !== null) resizeComposerField(field);
    }, [draft]);

    // ——— mutations ——————————————————————————————————————————————————————————
    const send = useCallback(() => {
        instance.execute<void>(CHAT_MESSAGE_SEND_COMMAND);
    }, [instance]);

    const submit = (event?: FormEvent<HTMLFormElement>) => {
        // The form is only a keyboard affordance: the page never navigates.
        event?.preventDefault();
        if (!canSend || sending) return;
        send();
    };

    const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
        const next = event.target.value;
        instance.execute<string>(CHAT_DRAFT_SET_COMMAND, next);
        // Grow immediately on the same keystroke, without waiting for the state
        // round-trip (oracle 5175-5178 does the same two things per change).
        resizeComposerField(event.currentTarget);
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        // IME confirmation fires Enter too — never submit half-composed text.
        if (event.nativeEvent.isComposing || event.key !== 'Enter' || event.shiftKey) return;
        // Below md the return key only grows the draft; the send button submits.
        if (!isDesktopViewport()) return;
        event.preventDefault();
        submit();
    };

    const handleBlur = (event: FocusEvent<HTMLFormElement>) => {
        // relatedTarget = the node focus is moving TO. Still inside the form
        // (input -> arrow -> select) keeps the arrow mounted.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
    };

    return (
        <form
            className="composer"
            data-testid="composer"
            onSubmit={submit}
            onFocus={() => setFocused(true)}
            onBlur={handleBlur}
        >
            <ModelPicker />

            <p className="composer__usage" data-testid="token-usage">
                Total tokens: {usage?.total_tokens ?? 0}
            </p>

            <div className="composer__field">
                {/* Voice mic: always visible (unlike the focus-gated arrow),
                    docked at the input's LEFT edge — tapping the input first
                    would just summon the on-screen keyboard (oracle 147-158). */}
                <VoiceButton />

                <textarea
                    ref={fieldRef}
                    className="composer__input"
                    data-testid="composer-input"
                    // one row by default: the browser's two-row default would
                    // otherwise survive the 'auto' measurement and lock an empty
                    // composer at two rows (oracle 5199-5203)
                    rows={1}
                    value={draft}
                    placeholder="Message the assistant..."
                    aria-label="Message the assistant"
                    onChange={handleChange}
                    onKeyDown={handleKeyDown}
                />

                {/* While a reply is in flight the arrow becomes the stop control:
                    `chat.message.cancel` returns false when nothing is running, so
                    the button only exists in the state where it can do something. */}
                {sending ? (
                    <button
                        type="button"
                        className="composer__send composer__send--stop"
                        aria-label="Stop generating reply"
                        title="Stop generating reply"
                        data-testid="cancel-button"
                        onClick={() => instance.execute<void, boolean>(CHAT_MESSAGE_CANCEL_COMMAND)}
                    >
                        <CloseIcon size={16} />
                    </button>
                ) : (
                    focused && (
                        <button
                            type="submit"
                            className="composer__send"
                            aria-label="Send message"
                            title="Send message"
                            data-testid="send-button"
                            // Empty draft: the affordance stays put but cannot
                            // fire (submit()'s guard is the second line of
                            // defence, matching the oracle's own guard).
                            disabled={!canSend}
                        >
                            <ChevronRightIcon size={16} />
                        </button>
                    )
                )}
            </div>

            <p className="composer__help">
                {sending
                    ? 'Generating — the stop control cancels the in-flight reply'
                    : 'Enter sends, Shift+Enter adds a newline'}
            </p>
        </form>
    );
}
