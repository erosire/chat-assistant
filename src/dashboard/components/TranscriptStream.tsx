// TranscriptStream — the transcript list: persisted turns, the system-prompt
// draft turn, the in-flight user bubble and the live assistant reply.
//
// BEHAVIOR ORACLE (read-only): src/components/ChatAssistantApp.tsx
//   - the system-prompt draft turn            4900-5022 (placeholder 'no prompt',
//                                             click-to-edit, sticky index -1)
//   - the pending user bubble                 5027-5043
//   - the streaming assistant turn            5044-5066 (three-dot loading state)
//   - the empty state                         5069-5072
//   - `streaming() === '' ? dots : text`      2552-2561 (the reported "blank box")
//
// THE LIST IS THE SCROLL CONTAINER. `ChatStage` owns its ref (one writer per
// scroll surface) and hands the per-section jump callback back down, so the
// chevrons, the follow effect and the sticky gates all measure the same element.
//
// LIVE REGION: `role="log"` + `aria-live` are declared AT MOUNT and never
// toggled — flipping aria-live when a run starts makes the browser treat the whole
// list as newly-live and re-announce existing entries (the review finding carried
// over from the example's TranscriptStream, packages/underload/dashboard/example/
// src/components/TranscriptStream.tsx:79-88). `aria-atomic="false"` +
// `aria-relevant="additions text"` announce only what arrived.
//
// NO MARKDOWN: every body is one text node; the streaming text is the provider's
// accumulated snapshot rendered the same way.
import { useCallback, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { ChatTurn } from '../contract';
import {
    CHAT_EDITING_INDEX_STATE,
    CHAT_EDITING_SYSTEM_STATE,
    CHAT_MODEL_STATE,
    CHAT_PENDING_STATE,
    CHAT_STATUS_STATE,
    CHAT_STREAMING_STATE,
    CHAT_SYSTEM_BEGIN_COMMAND,
    CHAT_SYSTEM_CANCEL_COMMAND,
    CHAT_SYSTEM_DRAFT_STATE,
    CHAT_SYSTEM_SAVE_COMMAND,
    CHAT_TURNS_STATE,
    type ChatStatus
} from '../contract';
import { useDashboardValue } from '../state-hooks';
import { useWorkbench } from '../workbench';
import { MessageTurn, useStickyStrip } from './MessageTurn';
import { InlineEdit } from './InlineEdit';
import { useModelLabels } from './ModelPicker';
import { CopyIcon } from '../../icons';

/** `chat.pending` as the domain plugin publishes it (null = nothing in flight). */
type PendingValue = { text: string; at: number } | null;

/** Stable empty list: `useSyncExternalStore` compares snapshots by reference. */
const NO_TURNS: readonly ChatTurn[] = [];

export type TranscriptStreamProps = {
    /** The stage's ref to the `[data-testid="transcript"]` scroll container. */
    listRef?: RefObject<HTMLOListElement>;
    /** Section-local edge jump (see ChatStage.jumpTurnEdge). */
    onJumpTurnEdge?: (testId: string, toTop: boolean) => void;
    /**
     * Overrides the status-derived rule. False hides every turn's mutation
     * controls (a delete or a prompt-persist owns the record). Omitted = read
     * `chat.status`, which is what the standalone surface does.
     */
    showControls?: boolean;
};

export function TranscriptStream({ listRef, onJumpTurnEdge, showControls }: TranscriptStreamProps) {
    const instance = useWorkbench();
    const turns = useDashboardValue<readonly ChatTurn[]>(CHAT_TURNS_STATE) ?? NO_TURNS;
    const pending = useDashboardValue<PendingValue>(CHAT_PENDING_STATE);
    const streaming = useDashboardValue<string>(CHAT_STREAMING_STATE);
    const status = useDashboardValue<ChatStatus>(CHAT_STATUS_STATE);
    const systemDraft = useDashboardValue<string>(CHAT_SYSTEM_DRAFT_STATE);
    const editingSystem = useDashboardValue<boolean>(CHAT_EDITING_SYSTEM_STATE);
    const model = useDashboardValue<string>(CHAT_MODEL_STATE);
    const { labelFor } = useModelLabels();

    const pendingText = pending === null ? '' : pending.text;
    // A reply is in flight while the user's text is un-answered, while any partial
    // text exists, or while the domain plugin says it is generating. Any one of
    // those alone is enough: a send sets pending before the first delta, a resume
    // can stream without a local pending, and `status` covers the waiting phase.
    const inFlight = pendingText !== '' || streaming !== '' || status === 'sending' || status === 'streaming';

    // ——— the store-owned editor ———————————————————————————————————————————
    // `chat.editingIndex` (number | null) is the transcript's inline-editor cell,
    // added to contract.ts by the chat core plugin precisely because "a
    // component-local editor index could not feed `chat.turns`" (contract.ts
    // 312-320). There is no begin/cancel COMMAND for it, so the view writes the
    // cell — the same precedent the core plugin itself follows for `chat.turns`,
    // and the one this task follows for `chat.sidebarTab` / `chat.drawerOpen`.
    // One editor for the whole surface, enforced by the cell holding one index.
    const editingIndex = useDashboardValue<number | null>(CHAT_EDITING_INDEX_STATE);
    // The click POINT offset captured on the opening click, consumed by the
    // remounted editor (null = caret at the text end, the jsdom fallback). This
    // one value stays component-local: it is pure view geometry, not state.
    const [caretOffset, setCaretOffset] = useState<number | null>(null);

    const beginEdit = useCallback(
        (index: number, offset: number | null) => {
            setCaretOffset(offset);
            instance.state<number | null>(CHAT_EDITING_INDEX_STATE).set(index);
        },
        [instance]
    );
    const endEdit = useCallback(() => {
        setCaretOffset(null);
        instance.state<number | null>(CHAT_EDITING_INDEX_STATE).set(null);
    }, [instance]);

    const anyEditing = editingIndex !== null || editingSystem || turns.some((turn) => turn.editing);

    // ——— the system-prompt draft turn (sticky sentinel index -1) ——————————————
    // It leads the chat even when EMPTY, showing the literal placeholder
    // "no prompt"; the copy action only exists once there is real text to copy
    // (oracle 4384-4391). It yields to a persisted leading system turn, which the
    // domain plugin represents by simply not exposing a draft (empty cell) and
    // rendering turn 0 as the system row.
    const draftRef = useRef<HTMLLIElement | null>(null);
    const draftControlsRef = useRef<HTMLDivElement | null>(null);
    const draftFloating = useStickyStrip(draftRef, draftControlsRef, `${editingSystem}:${systemDraft.length}`);
    const systemEmpty = systemDraft.trim() === '';
    // Mutation chrome visibility: an explicit prop wins, otherwise the status
    // rule — a history-rewriting save owns the record, provider waiting and
    // streaming deliberately do NOT (the dashboard must not look frozen).
    const controlsShown = showControls ?? status !== 'saving';

    const saveSystemDraft = (text: string) => {
        // `chat.system.save` takes void, so the committed DOM text is published to
        // its cell first: contract.ts registers `chat.systemDraft` as state but
        // publishes no system-draft setter command (same gap as the sidebar tab /
        // drawer cells — see the ChatSidebar header note).
        instance.state<string>(CHAT_SYSTEM_DRAFT_STATE).set(text);
        void instance.execute<void, Promise<void>>(CHAT_SYSTEM_SAVE_COMMAND);
    };

    // The draft row's own editor opens through `chat.system.begin` (the system-prompt
    // plugin owns the seed + the `-1` collapse sentinel), and closes through
    // `chat.system.cancel`, which reverts the DOM by unmounting the editor.
    const beginSystemEdit = () => instance.execute<void>(CHAT_SYSTEM_BEGIN_COMMAND);
    const cancelSystemEdit = () => instance.execute<void>(CHAT_SYSTEM_CANCEL_COMMAND);

    return (
        <ol
            className="stream__list"
            ref={listRef}
            data-testid="transcript"
            aria-label="Transcript"
            role="log"
            aria-live="polite"
            aria-atomic="false"
            aria-relevant="additions text"
        >
            {/* ——— system prompt: draft turn ———————————————————————————————— */}
            {/* The draft row leads the chat exactly while the record has NO
                persisted leading system turn — `hasPersistedSystemPrompt`'s
                inverse in the oracle (4363-4365), where the same row renders even
                when the draft is EMPTY (placeholder "no prompt"). */}
            {turns.length === 0 || turns[0]?.role !== 'system' ? (
                <li
                    ref={draftRef}
                    className="msg msg--system"
                    data-editing={editingSystem ? 'true' : 'false'}
                    data-phase="draft"
                    data-testid="system-prompt-turn"
                >
                    {/* First child = the header row the sticky gate measures
                        against (same shape as every persisted turn). */}
                    <div className="msg__head">
                        <div className="msg__lead" data-align="left">
                            {/* Nothing to fold on a draft row, so the label is a
                                plain span (oracle 4900-4913). */}
                            <span className="msg__role" data-testid="system-prompt-label">
                                system
                            </span>
                        </div>
                    </div>

                    {/* Keyed view/edit remount: abandoning the edit reverts the DOM,
                        which React reconciliation cannot do to a mutated
                        contentEditable node. */}
                    {editingSystem ? (
                        <InlineEdit
                            key="edit"
                            element="div"
                            className="msg__text msg__text--edit"
                            value={systemDraft}
                            caretOffset={systemDraft.length}
                            testId="system-prompt-value"
                            ariaLabel="Edit system prompt"
                            onCommit={saveSystemDraft}
                            onCancel={() => instance.execute<void>(CHAT_SYSTEM_CANCEL_COMMAND)}
                        />
                    ) : (
                        <div
                            key="view"
                            className="msg__text"
                            role="button"
                            tabIndex={0}
                            title="Click to edit"
                            data-empty={systemEmpty}
                            data-testid="system-prompt-value"
                            onClick={() => instance.execute<void>(CHAT_SYSTEM_BEGIN_COMMAND)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault();
                                    instance.execute<void>(CHAT_SYSTEM_BEGIN_COMMAND);
                                }
                            }}
                        >
                            {systemEmpty ? 'no prompt' : systemDraft}
                        </div>
                    )}

                    {/* The draft row's strip: copy only (a draft has no fork/role/
                        delete), and it STAYS RENDERED while its own editor is
                        open, greyed + disabled — the producing-chrome-never-
                        disappears rule (oracle 4975-4981). */}
                    {!systemEmpty && controlsShown ? (
                        <div
                            ref={draftControlsRef}
                            className={draftFloating ? 'msg__controls is-floating' : 'msg__controls'}
                            data-floating={draftFloating ? 'true' : 'false'}
                            data-testid="system-prompt-controls"
                        >
                            <span className="msg__jump" aria-hidden="true" />
                            <span className="msg__actions" role="group" aria-label="System prompt actions">
                                <button
                                    type="button"
                                    className="msg__ghost"
                                    disabled={editingSystem}
                                    aria-label="Copy system prompt"
                                    title="Copy system prompt"
                                    data-testid="copy-system-prompt"
                                    // Copying is a PURE CLIENT-SIDE action in the
                                    // oracle (3659-3680): the raw text goes to the
                                    // clipboard and storage is never touched, so
                                    // there is no command id for it — the message
                                    // copy command is index-based and a DRAFT has
                                    // no index. The clipboard API is optional here:
                                    // an unavailable one is a silent no-op rather
                                    // than an error banner.
                                    onClick={() => {
                                        if (typeof navigator === 'undefined' || !navigator.clipboard) return;
                                        void navigator.clipboard.writeText(systemDraft);
                                    }}
                                >
                                    <CopyIcon size={14} />
                                </button>
                            </span>
                        </div>
                    ) : null}
                </li>
            ) : null}

            {/* ——— persisted turns ————————————————————————————————————————— */}
            {turns.map((turn) => (
                <MessageTurn
                    key={`${turn.role}-${turn.index}`}
                    turn={turn}
                    labelFor={labelFor}
                    // The store's flag OR the list-local index — see the lifted
                    // editor above (a row never owns the one-editor rule alone).
                    editing={turn.editing || editingIndex === turn.index}
                    caretOffset={editingIndex === turn.index ? caretOffset : null}
                    anyEditing={anyEditing}
                    showControls={controlsShown}
                    onJump={onJumpTurnEdge}
                    onEditStart={beginEdit}
                    onEditEnd={endEdit}
                />
            ))}

            {/* ——— the in-flight user bubble ——————————————————————————————— */}
            {/* In-flight turns carry the SAME top-left attribution label as
                persisted ones (a plain span — they cannot collapse yet), so the
                turn chrome does not jump on completion; they carry NO controls
                panel, hence no section chevrons either (oracle 5027-5043). */}
            {pendingText !== '' ? (
                <li className="msg msg--user" data-phase="pending" data-testid="pending-user-turn">
                    <div className="msg__head">
                        <div className="msg__lead" data-align="right">
                            <span className="msg__role" data-testid="pending-user-label">
                                user
                            </span>
                        </div>
                    </div>
                    <div className="msg__text" data-testid="pending-user-message">
                        {pendingText}
                    </div>
                </li>
            ) : null}

            {/* ——— the streaming assistant turn ———————————————————————————— */}
            {inFlight ? (
                <li className="msg msg--assistant" data-phase="streaming" data-testid="streaming-turn">
                    <div className="msg__head">
                        <div className="msg__lead" data-align="left">
                            {/* The in-flight row is marked with the model PRODUCING
                                it — the send's model. The contract exposes only the
                                selected `chat.model`, which is the same value while
                                the send owns the surface (oracle 5044-5051). */}
                            <span className="msg__role" data-testid="streaming-message-model">
                                {labelFor(model)}
                            </span>
                        </div>
                    </div>
                    {/* LOADING STATE: before the provider delivers its first token
                        `chat.streaming` is '' and the bubble would render as a
                        featureless blank box. The three-dot pulse fills that phase,
                        and the FIRST token swaps it for the live text — the two
                        states never render together (oracle 2552-2561). */}
                    {streaming === '' ? (
                        <div className="msg__loading" role="status" data-testid="streaming-loading">
                            {/* Three dots; the stagger is CSS (`.msg__dot:nth-child`),
                                not an inline animation-delay, so the reduced-motion
                                token in tokens.css zeroes it like every other
                                animation in the skin. */}
                            <span className="msg__dot" />
                            <span className="msg__dot" />
                            <span className="msg__dot" />
                        </div>
                    ) : (
                        <div className="msg__text" data-testid="streaming-message">
                            {streaming}
                        </div>
                    )}
                </li>
            ) : null}

            {/* ——— empty state ———————————————————————————————————————————— */}
            {turns.length === 0 && pendingText === '' && streaming === '' ? (
                <li className="stream__empty" data-testid="empty-chat-state">
                    <strong>Start a conversation</strong>
                    <span>Ask the assistant anything to create your first chat.</span>
                </li>
            ) : null}
        </ol>
    );
}
