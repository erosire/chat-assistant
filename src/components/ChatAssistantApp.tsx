// Chat Assistant dashboard.
//
// Architecture: the chat-assistant API is pure conversation storage. Model traffic
// goes directly from this UI to the runtime provider endpoints
// (runtime/endpoint/provider/private): GET {provider}/models supplies the model
// dropdown and POST {provider}/chat/completions streams assistant replies (SSE)
// without any API key in the browser (the provider attaches credentials
// server-side). The reply renders live as it streams; the finished user+assistant
// pair is persisted through the identified conversation POST once the stream
// completes. The complete history is sent to whichever model is selected.
// On mount the sidebar restores the persisted chat history through the collection
// GET (summaries only); a selected chat's messages come from the identified GET.
// Model selection lives on the clickable model TEXT above the composer input:
// - the browser remembers the last model actually used (localStorage);
// - with nothing remembered, a selected chat's recorded model applies;
// - otherwise the first catalog entry sorted by MODEL NAME applies — provider /
//   organisation prefixes are stripped from labels ("zai-org/GLM-5.2-NVFP4" shows
//   as "GLM-5.2-NVFP4") but kept in values for provider routing.
// Per-message attribution (the assistant turn's top-left label) already marks
// WHICH model produced each reply, so no separate "Model: ..." strip exists.
// Conversation management lives ENTIRELY in the sidebar: "New chat" sits at
// its top-left and EVERY conversation entry carries an "x" delete control at
// its top-right corner that permanently deletes THAT conversation (identified
// DELETE) without entering it — deleting the currently selected chat also
// resets the surface to the empty new-chat state. The header title mirrors
// the selected chat's title
// (derived server-side from the trimmed first line of the first user message)
// and is renameable by clicking the title itself — INLINE: the h1 becomes
// contentEditable (blur/Enter commits, Escape cancels); no dialog exists.
// Every assistant response
// is marked in its TOP-LEFT corner with the model that produced it
// (per-message attribution persisted via ChatMessage.model). History is freely
// editable — SMART INLINE EDITING: there is NO input field. Clicking an
// expanded turn's WORDS (the bubble itself, hinted by an I-beam cursor) turns
// the bubble ITSELF into the editor (contentEditable, auto-focused, caret
// RESTORED ONTO THE CLICKED WORD via the captured click-point offset — see
// textOffsetFromPoint; pen-triggered edits place the caret at the text end);
// the pen icon does the same redundantly. The edit SAVES AUTOMATICALLY ON BLUR (the
// bubble's DOM text commits through the whole-history PUT; blank text just
// restores the original) and ESCAPE cancels (a keyed bubble remount reverts
// the DOM — React reconciliation cannot reset a mutated contentEditable node).
// While ANY turn is being edited NO turn chrome disappears: the header row —
// the producing-model/speaker label — stays rendered (only the edited turn's
// collapse toggle greys out + disables, so folding cannot unmount the live
// editor), and EVERY turn's edit pen, copy, and delete icons (the system
// prompt draft's pen/copy included) stay rendered but greyed out + natively
// disabled — one edit at a time, visible. Streaming and conversation deletion
// still hide those icons entirely.
// Messages remain individually deletable (x icon);
// next to the edit pen EVERY turn also carries a copy action (two-squares
// icon) that writes the raw message text to the system clipboard without
// touching storage;
// message edits, message deletes, and renames all replace the ENTIRE history
// through the identified PUT, so the next turn automatically sends the
// edited/shortened history to the provider. Every turn also carries a copy
// action next to the edit pen that writes the raw message text to the system
// clipboard (client-side only, no storage). Every chat is led by a SYSTEM
// prompt turn: a regular LEFT-aligned message row (same wrapper + bubble
// styling as the assistant) that sits at the start of the chat even while
// EMPTY — showing the literal placeholder "no prompt" with only an edit pen
// (clicking the bubble OR the pen turns the BUBBLE ITSELF into the
// contentEditable inline editor, saving on blur / cancelling on Escape,
// no copy while there is nothing to copy). A saved non-empty draft replaces
// the placeholder text and is persisted as the leading system message on the
// next send (prepended to the provider history); after that the system turn
// behaves like any other persisted turn (same inline editor, same copy
// action, same bubble styling, full-history PUT rewrites) EXCEPT it cannot
// be deleted. Assistant (and system) turns span the conversation's FULL
// content width (max-width:100%); user turns stay right-aligned under the
// narrower min(760px, 86%) cap — and every EXPANDED turn wrapper floors at
// min-width:50% of the list's content width so short bubbles still occupy
// about half the row, while COLLAPSED turns (label + one-line preview) keep
// no floor and stay compact. Every message TURN carries an attribution label in the
// TOP-LEFT corner of the row above its bubble: the producing model's name for
// assistant turns, the literal speaker ("user" / "system" for now) otherwise.
// That label IS the turn's collapse toggle — no chevron glyph ever renders.
// Collapsing folds the turn down to the label on its OWN line plus a one-line
// preview of its first line BELOW it — stacked, never inline; user-side
// stacks stay RIGHT-aligned (label and preview hug the right edge). Clicking
// the collapsed preview line (the visible "message") or
// the label expands it back. The delete cross stays on the row's right. By
// default EVERY turn starts COLLAPSED except the LATEST assistant reply —
// user turns fold to one-line previews of their questions, system turns fold
// (prompts can be long), and each older assistant reply folds once a newer
// reply lands; the collapsed set is re-seeded from the fresh record's default
// indices whenever a record loads or the history is replaced. Collapse is
// session-level UI state only. Composer keyboard rules: on DESKTOP (md+) Enter submits the
// message and Shift+Enter inserts a newline; on MOBILE (below md) Enter always
// inserts a newline so the on-screen keyboard's return key only grows the
// draft — submission stays on the send button. The composer is a slim modern
// COLUMN: the model selection is a quiet clickable TEXT line ABOVE the input
// (the stripped model name; the native dropdown select overlays it invisibly
// so clicking the text opens the real picker), and the send button is a
// circular ">" arrow pinned INSIDE the input box at its bottom-right corner —
// rendered ONLY while the composer has focus (focus-within via the form's
// onFocus/onBlur: moving between the input, the arrow, and the model select
// keeps it visible; leaving the composer hides it again). The composer input
// starts EXACTLY one text row tall (rows=1 + border-box height math that
// counts the 1px borders, so the first measurement can never inflate the
// box to the browser's two-row textarea default) and auto-grows with newlines
// up to eight rows; its right padding is deepened so text never slides under
// the embedded arrow. The layout needs no narrow-screen shrink defenses:
// the model text and the input stack vertically on every viewport. The
// sidebar is a
// static column on md+ screens and a toggleable drawer below the md breakpoint.
// The message list ALWAYS follows the conversation bottom: typing in the
// composer (the field grows and squeezes the list), the sent message's
// pending bubble, every streamed token of the reply, and every fresh record
// (chat selection, completed turn, edited history) re-pin the list's scroll
// position to its end — the list is the page's only scrolling surface (see
// the viewport-locked Page).
import React, { useCallback, useEffect } from 'react';
import { arrayEach, isString } from '@presource/core';
import { styledComponent, useReferenceHook, useStateHook } from '@presource/react';
import {
    addToConversation,
    createConversation,
    deleteConversation,
    fetchConversation,
    fetchProviderModels,
    listConversations,
    replaceConversationMessages,
    streamProviderChatCompletion,
    DEFAULT_CHAT_ASSISTANT_URL,
    DEFAULT_PROVIDER_URL,
    type ChatMessage,
    type ConversationRecord,
    type ConversationSummary
} from '../api';

// Palette is local to this distribution so the component has no dependency on a larger theme package.
const COLORS = {
    page: '#10131a',
    panel: '#171c25',
    panelStrong: '#1d2430',
    border: '#2d3746',
    text: '#e8ecf2',
    muted: '#9ca8b8',
    accent: '#7c9cff',
    accentStrong: '#5f82f0',
    user: '#273d72',
    assistant: '#202936',
    danger: '#ff9c9c'
} as const;

// Full-viewport application frame, LOCKED to the viewport: exactly the root's
// 100% height (index.html sets html/body/#root to height:100%) with the page's
// own overflow hidden, so the WINDOW never shows a scrollbar. The column then
// splits the viewport height into three regions: the header pinned to the top
// edge (flexShrink:0), the workspace filling the middle (flex:1 minHeight:0)
// where only INNER regions scroll (the sidebar column and the message list),
// and — inside the conversation column — the composer pinned to the bottom
// edge (flexShrink:0).
const Page = styledComponent('main', {
    height: '100%',
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    backgroundColor: COLORS.page,
    color: COLORS.text
});

// Header keeps the product name and the explicit actions visible on every screen
// size. flexShrink:0 pins it to the app frame's TOP edge: the viewport-locked
// page never scrolls (see Page), so the header sticks on top permanently.
// Padding collapses on narrow (xs) screens; the breakpoint map form is the
// documented styledComponent responsive mechanism (values under md apply from
// 900px up — see styleMedia in @presource/react).
const Header = styledComponent('header', {
    minHeight: 64,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    padding: () => ({ xs: '0 12px', md: '0 24px' }),
    borderBottom: `1px solid ${COLORS.border}`,
    backgroundColor: COLORS.panel
});

// Leading header group: the sidebar drawer toggle plus the product title. The
// toggle replaces the title's flush-left position only on mobile.
const HeaderLead = styledComponent('div', {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    minWidth: 0
});

// Sidebar drawer toggle (".Chats"): visible only below the md breakpoint, where
// the sidebar becomes an overlay drawer. On md+ displays it is display:none and
// the sidebar is a permanent grid column, so toggling is view-dependent by CSS —
// the React `open` state only matters for the xs drawer.
const SidebarToggle = styledComponent('button', {
    display: () => ({ xs: 'inline-flex', md: 'none' }),
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 36,
    minHeight: 36,
    padding: 0,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 6,
    backgroundColor: COLORS.panelStrong,
    color: COLORS.text,
    cursor: 'pointer',
    font: 'inherit',
    fontSize: 16,
    lineHeight: 1
}) as unknown as React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>>;

// Header title shows the SELECTED chat's title. With nothing selected (new
// chat) the product-name fallback is plain non-interactive text. With a chat
// selected the title ITSELF is the rename affordance — SMART INLINE EDITING
// exactly like the message bubbles: clicking it turns the h1 CONTENTEDITABLE
// (the `interactive` I-beam hints it), BLUR commits the rename, ENTER commits
// (titles are single-line), and ESCAPE cancels; NO dialog, NO input field.
const HeaderTitle = styledComponent<{ interactive?: boolean }>('h1', {
    margin: 0,
    fontSize: 20,
    lineHeight: 1.2,
    fontWeight: 700,
    letterSpacing: 0.2,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    cursor: ({ interactive }) => (interactive ? 'text' : 'default')
});

// Layout switches from a single mobile column to two columns at md (900px):
// below md the conversation surface is the only column and the sidebar floats
// above it as a drawer; md+ renders the classic 280px sidebar column.
const Workspace = styledComponent('div', {
    flex: 1,
    minHeight: 0,
    display: 'grid',
    gridTemplateColumns: () => ({ xs: 'minmax(0, 1fr)', md: '280px minmax(0, 1fr)' })
});

// Conversation navigation is independently scrollable so long histories do not
// hide the composer. Responsive behavior (the "toggled depending on view"
// requirement): below md it is a fixed left drawer whose `open` prop slides it
// in/out via transform; at md+ it is a static grid column and `open` is ignored
// (transform:none + position:static always win inside the media query).
// CRITICAL — zIndex MUST stay a STATIC number: FUNCTION values (breakpoint
// maps) pass through styleStructure (packages/presource/react/.../styled/
// utility/structure.ts), which converts EVERY number inside the map to rem —
// {xs: 20} becomes z-index:10rem, an INVALID value browsers silently drop.
// The drawer then painted at stack level 0 UNDER the scrim (z-index:10), so
// on mobile every tap inside the open drawer landed on the scrim and merely
// closed the menu — nothing was selectable. The static 20 is valid CSS, keeps
// the drawer above the scrim (10) and under dialogs (40), and is ignored on
// md+ where position:static makes z-index inapplicable anyway.
const Sidebar = styledComponent<{ open: boolean }>('aside', {
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    padding: 16,
    borderRight: `1px solid ${COLORS.border}`,
    backgroundColor: COLORS.panel,
    overflowY: 'auto',
    position: () => ({ xs: 'fixed', md: 'static' }),
    top: () => ({ xs: 0, md: 'auto' }),
    bottom: () => ({ xs: 0, md: 'auto' }),
    left: 0,
    width: () => ({ xs: 'min(280px, 85vw)', md: 'auto' }),
    zIndex: 20,
    transform: ({ open }) => ({ xs: open ? 'translateX(0)' : 'translateX(-105%)', md: 'none' }),
    transition: 'transform 160ms ease'
});

// Touch/click target that dismisses the mobile drawer; only rendered as visible
// below md while the drawer is open. zIndex stays under the sidebar's 20.
const SidebarScrim = styledComponent<{ open: boolean }>('div', {
    display: ({ open }) => ({ xs: open ? 'block' : 'none', md: 'none' }),
    position: 'fixed',
    inset: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    zIndex: 10
});

// Sidebar heading and empty-state copy share muted text treatment.
const SidebarHeading = styledComponent('div', {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: 1,
    textTransform: 'uppercase'
});

// Each sidebar conversation ENTRY is a positioning context: the select button
// fills it and the per-conversation "x" delete control overlays its top-right
// corner. The rule MUST stay exactly `position:relative` alone — the tests
// identify this rule by that single declaration.
const ChatEntry = styledComponent('div', {
    position: 'relative'
});

// Each conversation button presents the server summary without rendering message content in the sidebar.
// The right padding is deepened so a long title never slides under the
// overlaid "x" delete control in the entry's top-right corner.
const ChatButton = styledComponent('button', {
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 4,
    padding: '12px 32px 12px 12px',
    border: `1px solid ${COLORS.border}`,
    borderRadius: 8,
    backgroundColor: COLORS.panelStrong,
    color: COLORS.text,
    cursor: 'pointer',
    textAlign: 'left',
    font: 'inherit',
    transition: 'border-color 120ms ease, background-color 120ms ease'
}) as unknown as React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>>;

// Main conversation surface holds the message stream and the composer.
const Conversation = styledComponent('section', {
    minWidth: 0,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: COLORS.page
});

// Message list scrolls independently while the composer remains anchored at the bottom.
const MessageList = styledComponent('div', {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    padding: 24,
    overflowY: 'auto'
});

// Empty conversation state explains the one required action without inventing a fake assistant response.
const EmptyState = styledComponent('div', {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 24,
    color: COLORS.muted,
    textAlign: 'center'
});

// Turn wrappers own alignment and width bands so each bubble can sit together
// with its turn chrome (attribution label, edit controls, inline editor)
// inside one flex column — the bubbles themselves no longer self-align.
// The min-width floor applies ONLY WHILE EXPANDED (`collapsed` prop): an
// expanded turn occupies about half the row even for one-word content
// (min-width:50% of the list's content width); a COLLAPSED turn (label +
// one-line preview) carries no floor and shrinks to its content. The dynamic
// value serializes under @media (min-width: 0px) per variant — the tests
// locate EACH rendered turn's min-width via its own Emotion class for an
// exact expanded-vs-collapsed reading.
// User turns stay right-aligned under the narrow cap; ASSISTANT (and system —
// SystemTurn aliases AssistantTurn below) turns span the message list's FULL
// content width (max-width:100%) so long responses use the whole row.
const UserTurn = styledComponent<{ collapsed?: boolean }>('div', {
    alignSelf: 'flex-end',
    maxWidth: 'min(760px, 86%)',
    minWidth: ({ collapsed }) => (collapsed ? 'auto' : '50%'),
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: 4
});

const AssistantTurn = styledComponent<{ collapsed?: boolean }>('div', {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    minWidth: ({ collapsed }) => (collapsed ? 'auto' : '50%'),
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 4
});

// Message bubbles are separate styled elements so role-dependent styling never
// relies on inline objects. Width fills the turn wrapper. The `editable` prop
// marks the click-to-edit affordance: an editable bubble (idle persisted turn)
// carries the I-beam cursor, while non-editable surfaces (the transient
// pending/streaming bubbles, or bubbles while streaming/another edit runs)
// keep the default arrow. Dynamic → serializes under @media (min-width: 0px).
const UserMessage = styledComponent<{ editable?: boolean }>('article', {
    width: '100%',
    padding: '12px 16px',
    borderRadius: '16px 16px 4px 16px',
    backgroundColor: COLORS.user,
    color: COLORS.text,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    lineHeight: 1.5,
    cursor: ({ editable }) => (editable ? 'text' : 'default')
});

// box-sizing:border-box is load-bearing on the full-width assistant turn: a
// content-box width:100% would push the bubble 32px (its horizontal padding)
// PAST the wrapper's right edge once the wrapper pins at the list's content
// width, dragging a horizontal scrollbar into the message list.
const AssistantMessage = styledComponent<{ editable?: boolean }>('article', {
    width: '100%',
    boxSizing: 'border-box',
    padding: '12px 16px',
    borderRadius: '16px 16px 16px 4px',
    backgroundColor: COLORS.assistant,
    color: COLORS.text,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    lineHeight: 1.5,
    // Same click-to-edit cursor rule as UserMessage (see above).
    cursor: ({ editable }) => (editable ? 'text' : 'default')
});

// Row under a turn's bubble that holds ONLY the copy + edit action pair (the
// attribution label moved to the row ABOVE the bubble, where it doubles as the
// collapse toggle). box-sizing keeps the 4px side padding inside the turn.
// Used directly only as the base for TrailingControls, the row every turn
// actually renders.
const TurnControls = styledComponent('div', {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
    padding: '0 4px',
    width: '100%',
    boxSizing: 'border-box'
});

// Groups the copy + edit icon buttons so they stay glued together on the row's
// right edge — space-between on the parent TurnControls would otherwise spread
// them to opposite corners. copy sits immediately LEFT of the edit pen.
const TurnActionPair = styledComponent('div', {
    display: 'flex',
    alignItems: 'center',
    gap: 6
});

// The control row EVERY turn renders under its bubble: only the copy + edit
// pair, pushed to the row's right edge.
const TrailingControls = styledComponent(TurnControls, {
    justifyContent: 'flex-end'
});

// Row ABOVE every turn's bubble: the attribution label/collapse toggle (+
// one-line preview while collapsed) on the LEFT, the delete cross on the
// RIGHT — the cross floats above the message instead of overlapping its
// content. width:100% is required: turn wrappers shrink their column children
// to fit content (AssistantTurn's align-items:flex-start would otherwise
// left-pack the row). minHeight keeps the header row stable when no delete
// cross renders on its right (e.g. on collapsed turns, whose cross hides).
// align-items:flex-start pins the delete cross beside the LABEL line of a
// COLLAPSED turn's two-line stack (label over preview) instead of vertically
// centering it against both lines. width:100% is required: turn wrappers
// shrink their column children to fit content (AssistantTurn's align-items:
// flex-start would otherwise left-pack the row). minHeight keeps the header
// row stable when no delete cross renders on its right (e.g. on collapsed
// turns, whose cross hides).
const TurnHeaderRow = styledComponent('div', {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 6,
    padding: '0 4px',
    width: '100%',
    minHeight: 22,
    boxSizing: 'border-box'
});

// Lead group of the header row: label (line 1) + collapsed preview (line 2)
// STACK vertically — the collapsed view shows them on separate lines, never
// inline. User turns keep the stack RIGHT-aligned (alignRight), matching the
// wrapper's side; assistant/system turns stay left. The alignment is dynamic
// per side, so it serializes under @media (min-width: 0px) — the tests read
// each rendered lead's alignment via its own Emotion class.
const TurnHeaderLead = styledComponent<{ alignRight?: boolean }>('div', {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: ({ alignRight }) => (alignRight ? 'flex-end' : 'flex-start'),
    gap: 2
});

// Top-left attribution label of a persisted turn: the producing model's
// stripped name for assistant turns, the literal speaker ("user" / "system"
// for now) otherwise. The label IS the collapse toggle — clicking it folds or
// unfolds the turn, and NO chevron glyph ever accompanies it. Typography
// lives on the inner TurnLabelText so in-flight turns (which cannot collapse
// yet) can render the identical label as a plain span.
// The `greyed` prop dims the label + removes its pointer hint while its OWN
// turn is being edited (paired with the native disabled attribute at the
// render site): the producing-model name MUST stay visible mid-edit, but
// folding must not unmount the live editor. opacity/cursor are dynamic, so
// styledComponent serializes them under @media (min-width: 0px).
// CRITICAL: opacity is returned as a STRING — a number would pass through
// styleStructure ((value*8)/16 → rem) and come out as the invalid
// `opacity:0.2rem`, silently dropped by browsers (same trap as Sidebar's
// static zIndex — see its comment).
const TurnLabel = styledComponent<{ greyed?: boolean }>('button', {
    display: 'inline-flex',
    alignItems: 'center',
    minWidth: 0,
    padding: 0,
    border: 'none',
    borderRadius: 4,
    backgroundColor: 'transparent',
    opacity: ({ greyed }) => (greyed ? '0.4' : '1'),
    cursor: ({ greyed }) => (greyed ? 'default' : 'pointer'),
    font: 'inherit'
}) as unknown as React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { greyed?: boolean }>;

// Shared typography of the turn label: used inside TurnLabel for persisted
// turns and rendered bare for the in-flight pending/streaming turns.
const TurnLabelText = styledComponent('span', {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: 700,
    lineHeight: 1.3
});

// One-line preview BELOW the label of a collapsed turn: first line of the
// message, muted, ellipsis-truncated. In the lead's COLUMN layout it clamps
// to the wrapper width via max-width:100% (a nowrap span would otherwise
// force the shrink-fitted turn to grow) and never gets a box; its text aligns
// with the turn's side (user: right; assistant/system: left — dynamic, so it
// serializes under @media (min-width: 0px)). The preview is CLICKABLE — since
// no chevron exists, clicking the visible collapsed "message" expands the
// turn again.
const TurnPreview = styledComponent<{ alignRight?: boolean }>('span', {
    minWidth: 0,
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: ({ alignRight }) => (alignRight ? 'right' : 'left'),
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 1.4,
    cursor: 'pointer'
});

// The per-message delete control (x icon in the row above the bubble).
// The glyph stays plain text (U+00D7 MULTIPLICATION SIGN — text presentation,
// not emoji) with the accessible label on the button itself.
// The `greyed` prop (paired with native disabled at the render site) keeps
// the cross RENDERED but dimmed + inert while an inline edit runs anywhere —
// turn chrome never disappears mid-edit, it only fades. opacity/cursor are
// dynamic → serialized under @media (min-width: 0px) by styledComponent.
// opacity stays a STRING: a number would pass through styleStructure's
// number→rem conversion and yield the invalid `opacity:...rem` (see TurnLabel).
const MessageDeleteButton = styledComponent<{ greyed?: boolean }>('button', {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 22,
    minHeight: 22,
    padding: 0,
    border: 'none',
    borderRadius: 4,
    backgroundColor: 'transparent',
    color: COLORS.muted,
    opacity: ({ greyed }) => (greyed ? '0.4' : '1'),
    cursor: ({ greyed }) => (greyed ? 'default' : 'pointer'),
    font: 'inherit',
    fontSize: 13,
    lineHeight: 1
}) as unknown as React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { greyed?: boolean }>;

// The per-conversation delete control: the SAME "x" glyph treatment as the
// per-message delete, absolutely pinned to the top-right corner of a sidebar
// conversation entry (ChatEntry is its positioning context). It is a SIBLING
// of the select button inside the entry — not nested in it — so clicking the
// x deletes without ever triggering the entry's chat selection.
const ConversationDeleteButton = styledComponent(MessageDeleteButton, {
    position: 'absolute',
    top: 6,
    right: 6
}) as unknown as React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>>;

// Icon-only affordance for the per-message edit action (the pen) — and for
// the copy action paired beside it. The glyph stays plain text (U+270E LOWER
// RIGHT PENCIL — text presentation, not emoji) with the accessible label on
// the button itself.
// The `greyed` prop (paired with native disabled at the render site) keeps
// the pen/copy icons RENDERED but dimmed + inert while an inline edit runs
// anywhere: one edit at a time, but the icons never disappear mid-edit —
// they grey out instead. opacity/cursor are dynamic → serialized under
// @media (min-width: 0px) by styledComponent.
// opacity stays a STRING: a number would pass through styleStructure's
// number→rem conversion and yield the invalid `opacity:...rem` (see TurnLabel).
const TurnIconButton = styledComponent<{ greyed?: boolean }>('button', {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 22,
    minHeight: 22,
    padding: 0,
    border: 'none',
    borderRadius: 4,
    backgroundColor: 'transparent',
    color: COLORS.muted,
    opacity: ({ greyed }) => (greyed ? '0.4' : '1'),
    cursor: ({ greyed }) => (greyed ? 'default' : 'pointer'),
    font: 'inherit',
    fontSize: 13,
    lineHeight: 1
}) as unknown as React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { greyed?: boolean }>;

// The system prompt row leads every chat — whether the record leads with a
// persisted system message or the system prompt only exists as a local draft.
// Both forms render as regular turns with identical chrome (top-left "system"
// label, bubble, pen-driven inline editor); the draft form's persistence is
// deferred: a saved non-empty draft is stored locally until the next send
// persists it as the conversation's leading `system` message (prepended to
// the provider history AND persisted with the turn — see submit), after which
// the persisted system turn (editable + copyable, never deletable) takes over.
// System turns share the ASSISTANT turn layout exactly: LEFT-aligned wrapper
// spanning the list's full content width (no centering, no narrow cap) — the
// system prompt row reads just like an assistant/user row. Aliasing (instead
// of duplicating the CSS) keeps the layouts structurally locked together.
const SystemTurn = AssistantTurn;

// System turns get the SAME bubble treatment as user and assistant turns:
// identical padding (12px 16px), inherited font size and body text color
// (NOT a smaller muted caption), the shared 16px bubble radius (user's keeps
// its bottom-right tail, assistant's its bottom-left tail, system's is plain
// because the centered turn has no side), and the same 1.5 line box. Only the
// surface color differs — panelStrong — exactly like the user (#273d72) and
// assistant (#202936) surfaces differ from each other. The bubble fills the
// SystemTurn wrapper's width. The optional `empty` prop marks the
// not-yet-persisted DRAFT row's EMPTY state: its only text is the literal
// placeholder "no prompt", rendered muted so the placeholder reads as a
// placeholder and not as content.
const SystemMessage = styledComponent<{ empty?: boolean; editable?: boolean }>('article', {
    width: '100%',
    boxSizing: 'border-box',
    padding: '12px 16px',
    borderRadius: 16,
    backgroundColor: COLORS.panelStrong,
    color: ({ empty }) => (empty ? COLORS.muted : COLORS.text),
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    lineHeight: 1.5,
    // Same click-to-edit cursor rule as UserMessage (see above): the I-beam
    // hints that clicking the system bubble (even the "no prompt" placeholder)
    // opens the inline editor directly.
    cursor: ({ editable }) => (editable ? 'text' : 'default')
});

// Composer separates the editable input from the message list and exposes a stable
// test hook. flexShrink:0 pins it to the conversation column's BOTTOM edge: it
// never shrinks or scrolls away while the message list above absorbs all the
// overflow as the column's only scrolling surface. The composer is a single
// COLUMN (input full-width on top, focus-gated send control docked
// bottom-right below it — see SendGroup); align-items:stretch lets the input
// span the whole row.
const Composer = styledComponent('form', {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    flexShrink: 0,
    gap: 12,
    padding: 16,
    borderTop: `1px solid ${COLORS.border}`,
    backgroundColor: COLORS.panel
});

// Textarea starts EXACTLY one line high and grows through eight rows as
// newlines add content. The one-row height math is border-aware on purpose:
// box-sizing is border-box (matching the global box-sizing in index.html and
// making jsdom agree), so the visible box must hold the 1.4em line + 24px
// vertical padding + the 2px of vertical borders — shared with
// resizeMessageInput's inline heights and the send control's min-height, so
// every state of the input stays level with the button. rows=1 (set at the
// render site) removes the browser's two-row textarea default, which the
// resize effect would otherwise MEASURE as the empty box's scrollHeight and
// lock the field at two rows (the pre-fix bug: a new chat always showed a
// two-row composer). Mouse resizing is disabled so the composer height
// remains controlled by the message content. The composer is a COLUMN now
// (input on top, model text above), so the input spans the full row via
// width:100% — flex:1 would be a flex-basis:0 HEIGHT in a column and collapse
// the field. The RIGHT padding is deepened so typed text never slides under
// the embedded send arrow (32px circle at right:8px). Keyboard behavior (see
// the onKeyDown handler at the render site below): on DESKTOP (md+ viewport)
// Enter submits the message and Shift+Enter inserts a newline; on MOBILE
// Enter always inserts a newline and the send arrow performs submission.
const MessageInput = styledComponent('textarea', {
    width: '100%',
    minWidth: 0,
    minHeight: 0,
    boxSizing: 'border-box',
    height: 'calc(1.4em + 26px)',
    maxHeight: 'calc(1.4em * 8 + 26px)',
    resize: 'none',
    overflowY: 'auto',
    padding: '12px 52px 12px 14px',
    border: `1px solid ${COLORS.border}`,
    borderRadius: 8,
    backgroundColor: COLORS.page,
    color: COLORS.text,
    font: 'inherit',
    lineHeight: 1.4,
    outline: 'none'
}) as unknown as React.FC<React.TextareaHTMLAttributes<HTMLTextAreaElement>>;

// The model selection presentation: a quiet TEXT line sitting ABOVE the input
// (the stripped model name as muted label text — no button chrome). Shrink-
// wrapped (inline-flex) so the invisible select overlaying it covers exactly
// the clickable text, and flush-left inside the composer's column.
const ModelPicker = styledComponent('div', {
    position: 'relative',
    alignSelf: 'flex-start',
    display: 'inline-flex',
    alignItems: 'center'
});

// The model text itself: muted label typography reading as metadata, with the
// pointer cursor hinting the dropdown. Property ORDER matters for the tests
// (they identify this rule by its exact declaration sequence).
const ModelText = styledComponent('span', {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer'
});

// Positioning context for the embedded send arrow: wraps the input.
const ComposerField = styledComponent('div', {
    position: 'relative',
    width: '100%'
});

// The send button: a circular ">" arrow pinned INSIDE the input box at its
// bottom-right corner (position:absolute inside ComposerField), rendered ONLY
// while the composer has focus. border-radius:50% identifies this rule
// uniquely in Emotion's sheet (asserted by the tests).
const SendButton = styledComponent('button', {
    position: 'absolute',
    right: 8,
    bottom: 8,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
    padding: 0,
    border: 'none',
    borderRadius: '50%',
    backgroundColor: COLORS.accentStrong,
    color: '#ffffff',
    cursor: 'pointer',
    font: 'inherit',
    fontWeight: 700,
    fontSize: 15,
    lineHeight: 1
}) as unknown as React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>>;

// Native select layered invisibly over the model TEXT. Every click on the
// text actually lands on this select, which opens the real model dropdown;
// keeping it a native <select> preserves keyboard support and the existing
// data-testid="model-select" contract used by the tests (fireEvent.change
// selects a model by value).
const ModelSelect = styledComponent('select', {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    opacity: 0,
    cursor: 'pointer',
    font: 'inherit'
}) as unknown as React.FC<React.SelectHTMLAttributes<HTMLSelectElement>>;

// Secondary action is intentionally less visually dominant than sending a message.
const SecondaryButton = styledComponent('button', {
    padding: '6px 10px',
    border: `1px solid ${COLORS.border}`,
    borderRadius: 6,
    backgroundColor: COLORS.panelStrong,
    color: COLORS.text,
    cursor: 'pointer',
    font: 'inherit',
    fontSize: 12
}) as unknown as React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>>;

// "New chat" lives at the sidebar's top-left so all conversation management
// stays in one column; align-self keeps the compact button from stretching
// across the sidebar's full width.
const NewChatButton = styledComponent(SecondaryButton, {
    alignSelf: 'flex-start'
}) as unknown as React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>>;

// Small metadata labels keep model/status details available without competing with message text.
const Metadata = styledComponent('span', {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 1.3
});

// Error banner is explicit and non-modal so a failed provider request leaves
// the conversation usable. flexShrink:0: like the composer strip, it belongs
// to the fixed bottom chrome and must not shrink under list pressure.
const ErrorBanner = styledComponent('div', {
    flexShrink: 0,
    margin: '0 24px 12px',
    padding: '10px 12px',
    border: '1px solid rgba(255, 156, 156, 0.45)',
    borderRadius: 8,
    backgroundColor: 'rgba(255, 156, 156, 0.08)',
    color: COLORS.danger,
    fontSize: 13
});

// baseUrl points at the storage API; providerUrl points at the runtime provider
// (models catalog + chat completions). Tests and embedded deployments can override both.
export type ChatAssistantAppProps = {
    baseUrl?: string;
    providerUrl?: string;
};

// Browser storage key for the last model actually used: an explicit dropdown pick,
// a completed send, or a conversation model inherited when nothing was remembered.
const MODEL_STORAGE_KEY = 'chat-assistant:model';

// Strip the organisation/provider prefix for display: "zai-org/GLM-5.2-NVFP4" shows
// as "GLM-5.2-NVFP4". The FULL id remains the option value because the provider
// routes by id (runtime/endpoint/provider/private/models registry is keyed by id),
// so only labels are shortened, never the stored/sent value.
export const modelLabel = (id: string): string => {
    const slash = id.lastIndexOf('/');
    return slash >= 0 ? id.slice(slash + 1) : id;
};

// Storage access is guarded so locked-down or embedded browsers degrade to
// session-only model selection instead of crashing the dashboard.
const readRememberedModel = (): string => {
    try {
        return window.localStorage.getItem(MODEL_STORAGE_KEY) ?? '';
    } catch {
        return '';
    }
};

// Persist the model the user just used so the next session preselects it.
const rememberModel = (id: string): void => {
    try {
        if (id) window.localStorage.setItem(MODEL_STORAGE_KEY, id);
    } catch {
        // Persistence is best-effort; selection keeps working for the session.
    }
};

// Editing/view options handed from the component into message rendering so the
// render function itself stays module-level and deterministic.
type MessageListOptions = {
    // Index of the message currently under inline edit, or null when idle.
    editingIndex: number | null;
    // Edit affordances are hidden during streaming/deletion; one edit at a time.
    canEdit: boolean;
    // Turns a bubble INTO the inline HTML editor (contentEditable, focused).
    // The offset is the click's character position (see textOffsetFromPoint):
    // it restores the caret onto the CLICKED WORD after the editable remount;
    // null (pen-triggered) places the caret at the text end.
    onEditStart: (index: number, offset: number | null) => void;
    // Blur-delivered commit: the bubble's DOM text replaces the message via
    // whole-history PUT (see commitEdit in the component for guards).
    onEditCommit: (index: number, text: string) => void;
    // Escape/abandon: close without persisting; the keyed remount reverts the DOM.
    onEditCancel: () => void;
    onMessageDelete: (index: number) => void;
    // Copies a message's raw text to the system clipboard (client-side only).
    onMessageCopy: (content: string) => void;
    // Indices of currently collapsed turns (the fresh-record default seeds
    // this set: everything except the latest assistant reply). Pure
    // session-level UI state.
    collapsedTurns: number[];
    onToggleTurnCollapse: (index: number) => void;
};

// Read the text of a contentEditable bubble while preserving line structure.
// Browsers split lines via <div>/<p> wrappers and <br> breaks, and
// element.textContent loses BOTH (it concatenates line fragments without any
// separator) — committing raw textContent would silently fuse a multi-line
// edit into one line. The bubbles render with white-space:pre-wrap, so a
// plain '\n'-joined string round-trips exactly.
const editableTextContent = (element: HTMLElement): string => {
    const walk = (node: Node): string => {
        if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? '';
        if (node.nodeType !== Node.ELEMENT_NODE) return '';
        const tag = (node as HTMLElement).tagName;
        if (tag === 'BR') return '\n';
        const inner = Array.from(node.childNodes).map(walk).join('');
        // Block wrappers below the bubble root each own a line.
        if (node !== element && (tag === 'DIV' || tag === 'P')) return `${inner}\n`;
        return inner;
    };
    return Array.from(element.childNodes).map(walk).join('').replace(/\n+$/, '');
};

// Translate the click POINT (viewport coordinates) into a plain character
// offset inside the clicked element's text. The bubble only becomes
// contentEditable AFTER the click (a keyed remount), so the browser never
// natively places a caret on the pre-edit node — without this translation the
// editable remount's programmatic focus would always drop the caret at the
// START of the text instead of on the clicked word. caretRangeFromPoint is the
// Chrome/Safari API; Firefox exposes caretPositionFromPoint. jsdom implements
// NEITHER, so tests stub it or exercise the null fallback (caret at end).
const textOffsetFromPoint = (x: number, y: number, element: HTMLElement): number | null => {
    // Resolve the DOM position under the point across engines.
    let pointNode: Node | null = null;
    let pointOffset = 0;
    const caretRangeFromPoint = (document as Document & {
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
    }).caretRangeFromPoint;
    const caretPositionFromPoint = (document as Document & {
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node | null; offset: number } | null;
    }).caretPositionFromPoint;
    if (typeof caretRangeFromPoint === 'function') {
        const range = caretRangeFromPoint.call(document, x, y);
        if (!range) return null;
        pointNode = range.startContainer;
        pointOffset = range.startOffset;
    } else if (typeof caretPositionFromPoint === 'function') {
        const position = caretPositionFromPoint.call(document, x, y);
        if (!position) return null;
        pointNode = position.offsetNode;
        pointOffset = position.offset;
    } else {
        return null;
    }
    if (pointNode === null || !element.contains(pointNode)) return null;
    // Position resolved to the element itself (click past the last glyph on a
    // line): offset counts child NODES, so sum their text lengths.
    if (pointNode === element) {
        let total = 0;
        Array.from(element.childNodes).slice(0, pointOffset).forEach((child) => {
            total += (child.textContent ?? '').length;
        });
        return total;
    }
    // Position resolved inside a text node: sum the lengths of every preceding
    // text node (pre-wrap bubbles hold exactly one, but stay shape-general).
    let total = 0;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    while (current !== null) {
        if (current === pointNode) return total + pointOffset;
        total += (current.textContent ?? '').length;
        current = walker.nextNode();
    }
    // Unresolvable node shape (should not happen): fall back to the text end.
    return total;
};

// Collapse the caret at a character offset inside a freshly editable element.
// Offsets past the text length clamp to the end; an EMPTY element focuses at
// its (single possible) position. Used by the editing auto-focus effect to
// restore the click point captured via textOffsetFromPoint.
const placeCaretAtOffset = (element: HTMLElement, charOffset: number): void => {
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
        // Past-the-end or empty element: clamp to the last text node's end (or
        // the element itself when it holds no text at all).
        if (lastTextNode !== null) range.setStart(lastTextNode, (lastTextNode.textContent ?? '').length);
        else range.setStart(element, 0);
        range.collapse(true);
    }
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
};

// Convert an API record into message nodes while keeping rendering logic
// role-specific and explicit. User and assistant turns are freely editable (pen
// icon, right side of the controls row under the bubble) and individually
// deletable (x icon in the row ABOVE the bubble, right-aligned); both actions
// rewrite the whole history through the identified PUT. Every turn additionally
// carries a copy action (two-squares icon, immediately LEFT of the pen) that
// sends the raw message text to the clipboard. SYSTEM turns behave exactly like
// user/assistant turns (same inline editor, same copy action) EXCEPT they never
// render the delete cross — the system prompt cannot be removed (a chat without
// one shows the empty draft box above the list instead, not a system turn).
// Every turn's row ABOVE its bubble carries an ATTRIBUTION LABEL on the LEFT:
// the producing model's stripped name for assistant turns with a recorded
// ChatMessage.model (older records without it fall back to "assistant"),
// otherwise the literal speaker label ("user" / "system" for now). That label
// IS the collapse toggle — no chevron glyph ever renders. Collapsed turns hide
// the bubble AND its edit/copy/delete controls, showing the label plus a
// one-line first-line preview instead; clicking the preview expands the turn.
// While ANY turn is being edited NO chrome disappears: every turn's header row
// (the model/speaker label) stays rendered — its collapse toggle merely greys
// out + disables on the EDITED turn so folding cannot unmount the live editor —
// and every turn's pen/copy/delete icons stay rendered but greyed out +
// natively disabled (one edit at a time). Streaming and conversation deletion
// (canEdit === false) still hide the icons entirely, exactly as before.
const renderMessages = (messages: ChatMessage[], options: MessageListOptions): React.ReactNode[] => {
    const nodes: React.ReactNode[] = [];
    arrayEach(messages, ({ index, value: message }) => {
        const key = `${message.role}-${index}`;
        const editing = options.editingIndex === index;
        const collapsed = options.collapsedTurns.includes(index);
        // The pen (edit, controls row under the bubble), the copy action beside
        // it, and the delete cross appear on every idle, EXPANDED turn: none
        // during streaming/conversation deletion (canEdit), none while the turn
        // is collapsed (its bubble is hidden). While ANY turn is being edited
        // they all STAY RENDERED but greyed out + natively disabled
        // (controlsGreyed): one edit at a time, but no icon ever disappears
        // mid-edit — it only fades.
        const controlsGreyed = options.editingIndex !== null;
        const editControl = !collapsed && options.canEdit ? (
            <TurnIconButton
                type="button"
                greyed={controlsGreyed}
                disabled={controlsGreyed}
                onClick={() => options.onEditStart(index, null)}
                aria-label="Edit message"
                title="Edit message"
                data-testid={`edit-message-${index}`}
            >
                <span aria-hidden="true">✎</span>
            </TurnIconButton>
        ) : null;
        // The delete cross sits on the RIGHT of the header row above the bubble;
        // SYSTEM messages are the one non-deletable turn: edit + copy still apply.
        const deleteControl = !collapsed && options.canEdit && message.role !== 'system' ? (
            <MessageDeleteButton
                type="button"
                greyed={controlsGreyed}
                disabled={controlsGreyed}
                onClick={() => options.onMessageDelete(index)}
                aria-label="Delete message"
                title="Delete message"
                data-testid={`delete-message-${index}`}
            >
                <span aria-hidden="true">×</span>
            </MessageDeleteButton>
        ) : null;
        // Copying writes ANY message's raw text to the clipboard and never
        // touches storage. Visibility mirrors the edit pen. The glyph is
        // U+29C9 TWO JOINED SQUARES — plain text, not emoji.
        const copyControl = !collapsed && options.canEdit ? (
            <TurnIconButton
                type="button"
                greyed={controlsGreyed}
                disabled={controlsGreyed}
                onClick={() => options.onMessageCopy(message.content)}
                aria-label="Copy message"
                title="Copy message"
                data-testid={`copy-message-${index}`}
            >
                <span aria-hidden="true">⧉</span>
            </TurnIconButton>
        ) : null;
        // Smart inline editing: clicking the expanded bubble's WORDS turns the
        // bubble ITSELF into the editor (contentEditable — no textarea, no
        // separate input field), restoring the caret onto the CLICKED WORD via
        // the captured click-point offset (the pen does the same, caret at
        // end). The guard mirrors the pen exactly (idle, expanded, no other
        // edit running), so clicking is inert while streaming, deleting, or
        // editing another turn. The handler is undefined (not merely blocking)
        // while unavailable so the cursor hint and the click affordance agree.
        const openEditor = !collapsed && options.canEdit && options.editingIndex === null
            ? (event: React.MouseEvent<HTMLElement>) =>
                  options.onEditStart(index, textOffsetFromPoint(event.clientX, event.clientY, event.currentTarget))
            : undefined;
        // Shared bubble props for all three roles: the click target IS the
        // message text (`message-content-${index}`), with the I-beam cursor
        // and the affordance tooltip only while an edit CAN start.
        const editable = openEditor !== undefined;
        const bubbleProps = {
            editable,
            onClick: openEditor,
            title: editable ? 'Click to edit' : undefined,
            'data-testid': `message-content-${index}`
        };
        // Top-left attribution text: the producing model's stripped name for
        // assistant turns WITH per-message attribution (ChatMessage.model);
        // the literal role name otherwise ("user" / "system" for now — a real
        // speaker identity can replace these labels later).
        const speakerLabel = message.role === 'assistant' && message.model !== undefined
            ? modelLabel(message.model)
            : message.role;
        // Header row above the bubble: the attribution label (+ first-line
        // preview STACKED BELOW it while collapsed — label line over preview
        // line, never inline) on the turn's side (user turns right-aligned),
        // delete cross on the row's right. The label itself is the collapse
        // toggle — collapsing is pure view state. The row renders ALWAYS —
        // even while this turn is being edited — so the producing-model name
        // never disappears mid-edit; on the EDITED turn only the toggle greys
        // out + disables (folding would unmount the live editor bubble), which
        // also keeps the toggle from competing with the text caret.
        // No chevron glyph ever renders beside it.
        const alignRight = message.role === 'user';
        const headerRow = (
            <TurnHeaderRow>
                <TurnHeaderLead alignRight={alignRight}>
                    <TurnLabel
                        type="button"
                        greyed={editing}
                        disabled={editing}
                        onClick={() => options.onToggleTurnCollapse(index)}
                        aria-expanded={!collapsed}
                        aria-label={collapsed ? 'Expand message' : 'Collapse message'}
                        title={collapsed ? 'Expand message' : 'Collapse message'}
                        data-testid={`collapse-message-${index}`}
                    >
                        {/* `message-model-N` keeps the producing-model assertion
                            hook at the assistant turn's top-left (the former
                            caption position is gone); other roles get `message-label-N`. */}
                        <TurnLabelText
                            data-testid={message.role === 'assistant' && message.model !== undefined
                                ? `message-model-${index}`
                                : `message-label-${index}`}
                        >
                            {speakerLabel}
                        </TurnLabelText>
                    </TurnLabel>
                    {collapsed && (
                        // The collapsed "message" is this preview line BELOW the
                        // label: clicking it expands the turn again (there is no
                        // chevron to click).
                        <TurnPreview
                            alignRight={alignRight}
                            onClick={() => options.onToggleTurnCollapse(index)}
                            title="Expand message"
                            data-testid={`message-preview-${index}`}
                        >
                            {message.content.split('\n')[0]}
                        </TurnPreview>
                    )}
                </TurnHeaderLead>
                {deleteControl}
            </TurnHeaderRow>
        );
        // The bubble itself IS the inline HTML editor while its turn is being
        // edited: contentEditable + focused, BLUR commits the DOM text through
        // the whole-history PUT (via onEditCommit → commitEdit), ESCAPE cancels.
        // The key flips between 'view' and 'edit' so abandoning an edit REMOUNTS
        // the bubble — React never rewrites untouched contentEditable DOM (a
        // known reconciliation gap), and only a remount reliably restores the
        // original text. data-editing marks the node for the component's
        // auto-focus effect.
        const BubbleComponent: React.ElementType =
            message.role === 'user' ? UserMessage : message.role === 'assistant' ? AssistantMessage : SystemMessage;
        const bubble = collapsed ? null : editing ? (
            <BubbleComponent
                key="edit"
                role="textbox"
                aria-multiline="true"
                aria-label="Edit message"
                contentEditable
                suppressContentEditableWarning
                data-editing="true"
                onBlur={(event: React.FocusEvent<HTMLElement>) => options.onEditCommit(index, editableTextContent(event.currentTarget))}
                onKeyDown={(event: React.KeyboardEvent<HTMLElement>) => {
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        options.onEditCancel();
                    }
                }}
                data-testid={`message-content-${index}`}
            >
                {message.content}
            </BubbleComponent>
        ) : (
            <BubbleComponent key="view" {...bubbleProps}>
                {message.content}
            </BubbleComponent>
        );
        if (message.role === 'user') {
            // The controls row renders while the turn is expanded and idle —
            // INCLUDING while it (or another turn) is being edited: the
            // greyed-out + disabled pen/copy pair stays visible under the
            // editor bubble instead of disappearing.
            nodes.push(
                <UserTurn key={key} collapsed={collapsed} data-testid={`message-turn-${index}`}>
                    {headerRow}
                    {bubble}
                    {editControl !== null && (
                        <TrailingControls><TurnActionPair>{copyControl}{editControl}</TurnActionPair></TrailingControls>
                    )}
                </UserTurn>
            );
        } else if (message.role === 'assistant') {
            // The producing model marks the turn in its top-left header label
            // (see headerRow above, replacing the old caption under the bubble);
            // the row below carries only the shared copy + edit pair, exactly
            // like the other roles.
            nodes.push(
                <AssistantTurn key={key} collapsed={collapsed} data-testid={`message-turn-${index}`}>
                    {headerRow}
                    {bubble}
                    {editControl !== null && (
                        <TrailingControls><TurnActionPair>{copyControl}{editControl}</TurnActionPair></TrailingControls>
                    )}
                </AssistantTurn>
            );
        } else {
            // System turn: same edit pen + copy action as every other turn, but
            // NO delete cross — the system prompt cannot be removed. It starts
            // collapsed by default (the component seeds collapsedTurns with the
            // record's default collapsed indices — every turn except the latest
            // assistant reply — whenever a fresh record loads).
            nodes.push(
                <SystemTurn key={key} collapsed={collapsed} data-testid={`message-turn-${index}`}>
                    {headerRow}
                    {bubble}
                    {editControl !== null && (
                        <TrailingControls><TurnActionPair>{copyControl}{editControl}</TurnActionPair></TrailingControls>
                    )}
                </SystemTurn>
            );
        }
    });
    return nodes;
};

// Derive the compact sidebar summary from a full record; shared by the send and
// edit flows so both keep the list entry consistent with the persisted record.
const summaryFromRecord = (result: ConversationRecord): ConversationSummary => ({
    conversationId: result.conversationId,
    title: result.title,
    model: result.model,
    status: result.status,
    messageCount: result.messages.length,
    createdAt: result.createdAt,
    updatedAt: result.updatedAt
});

// Indices of every turn that starts COLLAPSED when a fresh record loads or
// replaces the history: ALL user turns (their questions stay skim-able as
// one-line previews), all system turns (prompts can be long), and every
// assistant turn EXCEPT the latest reply — the single turn expanded by
// default. A record without any assistant reply collapses everything.
const defaultCollapsedIndices = (messages: ChatMessage[]): number[] => {
    // The LAST assistant turn in history order is the one expanded by default.
    let latestAssistantIndex = -1;
    arrayEach(messages, ({ index, value }) => {
        if (value.role === 'assistant') latestAssistantIndex = index;
    });
    const indices: number[] = [];
    arrayEach(messages, ({ index }) => {
        if (index !== latestAssistantIndex) indices.push(index);
    });
    return indices;
};

// Viewport gate for the composer's Enter-to-send rule: true at/above the md
// breakpoint (900px, the same threshold the CSS media queries use — see
// styledComponent's breakpoints in @presource/react). jsdom implements no
// matchMedia, so a missing API counts as DESKTOP (the browser default);
// tests stub matchMedia to exercise the mobile branch.
const isDesktopViewport = (): boolean =>
    typeof window.matchMedia !== 'function' || window.matchMedia('(min-width: 900px)').matches;

// Vertical border thickness of MessageInput (1px top + 1px bottom, matching
// its authored `border: 1px solid`). The field is box-sizing:border-box but
// scrollHeight EXCLUDES borders, so this constant is added back onto every
// measurement: without it a one-row box comes out 2px short, the line
// overflows the content area, and overflowY:auto delivers a jittery 2px
// scroll. Kept a constant (not read from computed style) so jsdom — which
// does not expand the `border` shorthand — computes identical values.
const MESSAGE_INPUT_VERTICAL_BORDER = 2;

// Resize the textarea from its content height while capping the visible
// editor at eight rows; resetting height first also shrinks the field after
// deletion. The input renders `rows={1}` (see the render site) so the
// transient 'auto' height measured here is the one-row box rather than the
// two-row browser default — scrollHeight never dips below the frame's own
// client box, which is exactly how the pre-fix empty composer got locked at
// two rows. Heights are OUTER (border-box): scrollHeight + borders, floored
// at the one-row outer height, capped at eight rows outer.
const resizeMessageInput = (element: HTMLTextAreaElement): void => {
    element.style.height = 'auto';
    const computed = window.getComputedStyle(element);
    const lineHeight = Number.parseFloat(computed.lineHeight) || 22.4;
    const verticalPadding =
        (Number.parseFloat(computed.paddingTop) || 0) + (Number.parseFloat(computed.paddingBottom) || 0);
    const oneRowHeight = lineHeight + verticalPadding + MESSAGE_INPUT_VERTICAL_BORDER;
    const maxHeight = lineHeight * 8 + verticalPadding + MESSAGE_INPUT_VERTICAL_BORDER;
    const contentHeight = Math.max(element.scrollHeight + MESSAGE_INPUT_VERTICAL_BORDER, oneRowHeight);
    element.style.height = `${Math.min(contentHeight, maxHeight)}px`;
};

// Main dashboard state and event handlers.
export const ChatAssistantApp: React.FC<ChatAssistantAppProps> = React.memo(({
    baseUrl = DEFAULT_CHAT_ASSISTANT_URL,
    providerUrl = DEFAULT_PROVIDER_URL
}) => {
    // Accessor state follows @presource/react's state-hook contract: read with (), write with (value).
    const chats = useStateHook<ConversationSummary[]>([]);
    const selected = useStateHook<ConversationRecord | null>(null);
    // Available provider model ids, loaded once from GET {provider}/models and kept
    // sorted by stripped model name (NOT by organisation prefix).
    const models = useStateHook<string[]>([]);
    // Currently selected model. Initialised from the remembered last-used model,
    // else the first sorted catalog entry; a selected chat's recorded model only
    // applies when nothing is remembered yet.
    const model = useStateHook('');
    const message = useStateHook('');
    // Local draft for the system prompt turn, shown ONLY while the selected
    // record lacks a leading system message. While EMPTY the turn's bubble
    // shows the literal placeholder "no prompt"; a saved non-empty draft is
    // persisted as the leading system message on the next send (see submit).
    // Cleared on new chat, on chat switch, on conversation deletion, and
    // after a completed send.
    const systemPrompt = useStateHook('');
    // The draft turn's own inline editing flag (opened by clicking its bubble
    // or its pen): there is NO textarea state — the bubble IS the editor
    // (contentEditable), its text lives in the DOM until blur commits the
    // trimmed text into `systemPrompt` or Escape cancels (the keyed remount
    // reverts the DOM to the saved draft).
    const editingSystemPrompt = useStateHook(false);
    // Indices of currently collapsed message turns. Seeded via
    // defaultCollapsedIndices (ALL turns except the latest assistant reply:
    // user turns fold, system turns fold, older replies fold) whenever a fresh
    // record loads or replaces the history; resetting accompanies new chat /
    // chat switch / deletion. Session-level UI state, never persisted.
    const collapsedTurns = useStateHook<number[]>([]);
    const loading = useStateHook(false);
    // True while the selected conversation's identified DELETE is in flight.
    const deleting = useStateHook(false);
    const error = useStateHook('');
    // In-flight turn rendered live BEFORE persistence: the user's pending message
    // and the assistant reply as it streams in. Both clear once the pair is saved
    // (or when the stream fails, after the composer text is restored).
    const pendingUser = useStateHook('');
    const streaming = useStateHook('');
    // The split send control renders ONLY while focus is inside the composer
    // (focus-within on the form: input, both button halves, and the model
    // select all count). Hidden otherwise, keeping the idle composer a bare
    // full-width text field.
    const composerFocus = useStateHook(false);
    // Mobile drawer state; at md+ the sidebar is a permanent column and this
    // state is ignored by CSS (the toggle button is display:none there).
    const sidebarOpen = useStateHook(false);
    // Inline history editing: index of the message whose bubble currently IS
    // the editor (contentEditable). `savingEdit` guards the identified PUT
    // that replaces the history on blur-commit.
    const editingIndex = useStateHook<number | null>(null);
    const savingEdit = useStateHook(false);
    // Header title rename: the h1 ITSELF is the editor (contentEditable) —
    // no dialog, no input field, so there is NO draft state; only the flag
    // plus a dedicated saving flag (the rename rides the same identified PUT,
    // with the history round-tripping unchanged).
    const editingTitle = useStateHook(false);
    const savingTitle = useStateHook(false);
    // Ref-backed handoff of the click's character offset: the click handler
    // writes it (no re-render wanted) and the editing auto-focus effect reads
    // it ONCE to restore the caret onto the clicked word after the editable
    // remount — then clears it so pen-triggered edits fall back to the text
    // end. See textOffsetFromPoint / placeCaretAtOffset.
    const caretOffset = useReferenceHook<number | null>(null);

    // Load the provider model catalog once on mount. The provider needs no API key
    // from the browser, so no credentials are handled here.
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const catalog = await fetchProviderModels(providerUrl);
                if (cancelled) return;
                // Sort by the stripped model name so both the dropdown order and the
                // fresh-browser default follow model names, not organisation prefixes.
                const ids = catalog
                    .map((entry) => entry.id)
                    .sort((a, b) => modelLabel(a).localeCompare(modelLabel(b)));
                models(ids);
                // Priority: remembered last-used model, else first sorted catalog entry.
                // The catalog default itself is NOT persisted — only explicit picks and
                // models that produced a turn are remembered (submit / selectChat).
                if (!model()) {
                    const initial = readRememberedModel() || ids[0] || '';
                    if (initial) model(initial);
                }
            } catch (reason) {
                if (!cancelled) error(reason instanceof Error ? reason.message : String(reason));
            }
        })();
        return () => {
            cancelled = true;
        };
        // Mount-only effect: the model catalog is static for the session while the
        // accessor functions (models/model/error) are stable state-hook handles.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [providerUrl]);

    // Load the persisted conversation list once on mount so the sidebar restores
    // the chat history after a reload. Summaries carry no message bodies; selecting
    // a restored chat fetches its full record through the identified GET.
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const result = await listConversations(baseUrl);
                if (!cancelled) chats(result.conversations);
            } catch (reason) {
                if (!cancelled) error(reason instanceof Error ? reason.message : String(reason));
            }
        })();
        return () => {
            cancelled = true;
        };
        // Mount-only effect: the history list is re-synced after each completed
        // turn (submit updates the summaries); chats/error are stable state-hook
        // handles.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [baseUrl]);

    // Keep the editor synchronized with programmatic clears and restored values;
    // the input handler performs the same calculation immediately after typing.
    useEffect(() => {
        const input = document.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]');
        if (input) resizeMessageInput(input);
    }, [message()]);

    // Follow the conversation bottom: typing (the growing composer squeezes
    // the list upward), the sent message's pending bubble, every streamed
    // token, and any fresh record (chat selection, completed turn, edited or
    // shortened history) all re-pin the message list — the page's only
    // scrolling surface — to its end so the latest turn stays in view.
    // scrollTop/scrollHeight are plain settable properties everywhere
    // (jsdom included: scrollHeight is 0 there, so tests stub it).
    useEffect(() => {
        const list = document.querySelector<HTMLElement>('[data-testid="message-list"]');
        if (list) list.scrollTop = list.scrollHeight;
        // Deps read accessor state: draft text, pending bubble, stream, record.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [message(), pendingUser(), streaming(), selected()]);

    // Focus the surface that just became the inline HTML editor (a message
    // bubble, the system prompt draft bubble, or the header title). The node
    // remounts keyed on entering edit mode, so the effect (not a ref callback)
    // focuses the fresh node — no ref-identity churn can steal the caret back
    // on unrelated re-renders. The caret is then RESTORED to the click's
    // captured character offset (without it, programmatic focus dumps the
    // caret at the text start); null offset (pen-triggered, or jsdom without
    // caretRangeFromPoint) lands at the text end.
    useEffect(() => {
        if (editingIndex() !== null || editingSystemPrompt() || editingTitle()) {
            const target = document.querySelector<HTMLElement>('[data-editing="true"]');
            if (target) {
                target.focus();
                placeCaretAtOffset(target, caretOffset() ?? Number.MAX_SAFE_INTEGER);
                caretOffset(null);
            }
        }
        // Deps read accessor state: all independent edit flags.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editingIndex(), editingSystemPrompt(), editingTitle()]);

    // Inherit a conversation's recorded model ONLY when the browser has not
    // remembered one yet; the inherited model then becomes the remembered one.
    const applyModelMemory = useCallback((recordModel: string) => {
        if (!readRememberedModel()) {
            model(recordModel);
            rememberModel(recordModel);
        }
    }, [model]);

    // Abandon the inline bubble edit (Escape, chat switching, new chat,
    // deletion); the keyed remount reverts the bubble's DOM to the persisted
    // text, so nothing else is needed here.
    const cancelEdit = useCallback(() => {
        editingIndex(null);
    }, [editingIndex]);

    // Stop editing the header title (Escape, chat switching, new chat,
    // deletion); the keyed h1 remount reverts the discarded DOM text, so
    // nothing else is needed here.
    const cancelTitleEdit = useCallback(() => {
        editingTitle(false);
    }, [editingTitle]);

    // Turn the header title ITSELF into the inline editor (contentEditable,
    // auto-focused + caret-restored by the editing effect) — no dialog.
    // Blocked while a turn streams/deletes (the old dialog's disabled state
    // made the same gate).
    const startTitleEdit = useCallback((offset: number | null = null) => {
        if (loading() || deleting()) return;
        caretOffset(offset);
        editingTitle(true);
    }, [caretOffset, deleting, editingTitle, loading]);

    // Stop editing the system prompt draft (Escape, chat switching, new chat,
    // deletion, completed send). The saved draft (systemPrompt) is NOT touched
    // here — the keyed bubble remount reverts any half-typed DOM text.
    const cancelSystemPromptDraft = useCallback(() => {
        editingSystemPrompt(false);
    }, [editingSystemPrompt]);

    // Turn the draft prompt's bubble into the inline editor (click on its
    // words or its pen). The bubble renders the saved draft's text; editing
    // happens in the DOM until blur commits. The offset restores the caret to
    // the clicked word (null → text end, e.g. the pen).
    const startSystemPromptEdit = useCallback((offset: number | null = null) => {
        caretOffset(offset);
        editingSystemPrompt(true);
    }, [caretOffset, editingSystemPrompt]);

    // Commit the draft bubble's BLUR-delivered text. Save stays LOCAL: the
    // draft persists as the conversation's leading system message only on the
    // next send (see submit). A blank commit trims to empty and the turn falls
    // back to the "no prompt" placeholder. The flag guard rejects stale blurs
    // landing after an Escape-cancel on the same DOM node.
    const saveSystemPromptDraft = useCallback((rawText: string) => {
        if (!editingSystemPrompt()) return;
        systemPrompt(rawText.trim());
        editingSystemPrompt(false);
    }, [editingSystemPrompt, systemPrompt]);

    // Select a conversation and fetch its full message history; the recorded model
    // applies only when nothing is remembered (a remembered/picked model wins).
    const selectChat = useCallback(async (conversationId: string) => {
        loading(true);
        try {
            const record = (await fetchConversation(baseUrl, conversationId)).conversation;
            selected(record);
            applyModelMemory(record.model);
            // Picking a chat closes the mobile drawer (md+ ignores the drawer
            // state via CSS) and resets any editors left open on the previous chat.
            sidebarOpen(false);
            cancelEdit();
            cancelTitleEdit();
            // The system prompt draft (and its open editor) belongs to the
            // previous chat's surface, and turn collapse re-seeds from the
            // freshly loaded record (every turn folds except its latest
            // assistant reply).
            systemPrompt('');
            cancelSystemPromptDraft();
            collapsedTurns(defaultCollapsedIndices(record.messages));
            error('');
        } catch (reason) {
            error(reason instanceof Error ? reason.message : String(reason));
        } finally {
            loading(false);
        }
    }, [applyModelMemory, baseUrl, cancelEdit, cancelSystemPromptDraft, cancelTitleEdit, collapsedTurns, error, loading, selected, sidebarOpen, systemPrompt]);

    // Reset the surface without creating a server record until the first provider
    // turn completes. The model selection intentionally survives a new chat so the
    // last-used model stays preselected. The button lives in the sidebar, so the
    // mobile drawer closes when a fresh chat starts.
    const startNewChat = useCallback(() => {
        selected(null);
        message('');
        // A fresh chat starts the system prompt draft back at its "no prompt"
        // placeholder (editor closed), with no collapsed turns yet.
        systemPrompt('');
        cancelSystemPromptDraft();
        collapsedTurns([]);
        error('');
        sidebarOpen(false);
        cancelEdit();
        cancelTitleEdit();
    }, [cancelEdit, cancelSystemPromptDraft, cancelTitleEdit, collapsedTurns, error, message, selected, sidebarOpen, systemPrompt]);

    // Permanently delete ONE conversation from its sidebar entry's "x"
    // (identified DELETE): drop its summary from the list. Only when the
    // deleted entry IS the open chat does the surface reset to the empty
    // new-chat state (any other chat stays open and selected). The model
    // selection survives either way, matching startNewChat. Blocked while a
    // turn is streaming so a late-arriving stream cannot resurrect the chat.
    const deleteChat = useCallback(async (conversationId: string) => {
        if (deleting() || loading()) return;
        deleting(true);
        try {
            await deleteConversation(baseUrl, conversationId);
            chats(chats().filter((chat) => chat.conversationId !== conversationId));
            if (selected()?.conversationId === conversationId) {
                selected(null);
                message('');
                // Deleting the open chat returns to a fresh surface: prompt
                // draft placeholder + collapse set reset too.
                systemPrompt('');
                cancelSystemPromptDraft();
                collapsedTurns([]);
                cancelEdit();
                cancelTitleEdit();
            }
            error('');
        } catch (reason) {
            error(reason instanceof Error ? reason.message : String(reason));
        } finally {
            deleting(false);
        }
    }, [baseUrl, cancelEdit, cancelSystemPromptDraft, cancelTitleEdit, chats, collapsedTurns, deleting, error, loading, message, selected, systemPrompt]);

    // Turn one message's bubble into the inline HTML editor (contentEditable,
    // auto-focused by the editing effect above). The offset restores the caret
    // to the clicked word; null (pen) lands at the text end.
    const startEdit = useCallback((index: number, offset: number | null = null) => {
        caretOffset(offset);
        editingIndex(index);
    }, [caretOffset, editingIndex]);

    // Remove a single message and persist the shortened history through the same
    // identified PUT the inline editor's blur-commit uses; the next provider
    // turn automatically sends the shortened history as its context. Guarded by
    // savingEdit like commitEdit so two history rewrites can never race.
    const deleteMessage = useCallback(async (index: number) => {
        const record = selected();
        if (!record || savingEdit()) return;
        savingEdit(true);
        try {
            const messages = record.messages.filter((_, candidate) => candidate !== index);
            const result = (await replaceConversationMessages(baseUrl, record.conversationId, { messages })).conversation;
            selected(result);
            const summary = summaryFromRecord(result);
            chats(chats().map((chat) => (chat.conversationId === summary.conversationId ? summary : chat)));
            // A deletion can shift indices, so any open edit is abandoned and
            // the collapse set re-seeds from the shortened record's defaults
            // (everything folds except its latest assistant reply).
            cancelEdit();
            collapsedTurns(defaultCollapsedIndices(result.messages));
            error('');
        } catch (reason) {
            error(reason instanceof Error ? reason.message : String(reason));
        } finally {
            savingEdit(false);
        }
    }, [baseUrl, cancelEdit, chats, collapsedTurns, error, savingEdit, selected]);

    // Copy any message's raw text to the system clipboard (the action next to
    // the edit pen on every turn). The async Clipboard API is preferred; the
    // hidden-textarea + execCommand path keeps older or permission-restricted
    // browsers working (jsdom has neither, so tests stub navigator.clipboard).
    // This is a pure client-side action: storage is never involved; failures
    // surface in the shared error banner instead of throwing unhandled.
    const copyMessage = useCallback(async (content: string) => {
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(content);
            } else {
                const scratch = document.createElement('textarea');
                scratch.value = content;
                // Fixed + transparent keeps the scratch element out of layout and view.
                scratch.style.position = 'fixed';
                scratch.style.opacity = '0';
                document.body.appendChild(scratch);
                scratch.select();
                document.execCommand('copy');
                document.body.removeChild(scratch);
            }
            error('');
        } catch (reason) {
            error(reason instanceof Error ? reason.message : String(reason));
        }
    }, [error]);

    // Commit a rename delivered by the title h1's BLUR (or Enter): the SAME
    // identified PUT the message editor uses — the history round-trips
    // unchanged while the explicit title wins over the server's first-line
    // derivation. Guards mirror commitEdit: the editing flag rejects stale
    // blurs after an Escape-cancel; blank/unchanged titles close without a
    // request (blank titles are forbidden, and the keyed h1 remount restores
    // the persisted one); the conversation guard keeps a blur-commit that
    // raced a chat switch/new chat from resurrecting the old title onto the
    // fresh surface. loading() still blocks a rename while a turn streams so
    // a late append-follow-up GET cannot overwrite it (and vice versa).
    const saveTitle = useCallback(async (rawTitle: string) => {
        if (!editingTitle()) return;
        const record = selected();
        const title = rawTitle.trim();
        cancelTitleEdit();
        if (!record || !title || savingTitle() || loading() || title === record.title) return;
        savingTitle(true);
        try {
            const result = (await replaceConversationMessages(baseUrl, record.conversationId, {
                messages: record.messages,
                title
            })).conversation;
            if (selected()?.conversationId === record.conversationId) selected(result);
            const summary = summaryFromRecord(result);
            chats(chats().map((chat) => (chat.conversationId === summary.conversationId ? summary : chat)));
            error('');
        } catch (reason) {
            error(reason instanceof Error ? reason.message : String(reason));
        } finally {
            savingTitle(false);
        }
    }, [baseUrl, cancelTitleEdit, chats, editingTitle, error, loading, savingTitle, selected]);

    // Commit an inline bubble edit delivered by BLUR: the bubble's DOM text
    // replaces the message's content by REPLACING the complete history through
    // the identified PUT. The server returns the canonical record
    // (messageCount/updatedAt and a re-derived title when the first user turn
    // changed), which re-syncs both the selection and the sidebar summary.
    // Turn submission always builds the provider payload from
    // selected().messages, so the next chat message automatically sends the
    // edited history to the model. Guards, in order:
    // - editingIndex must still match (rejects a stale blur landing on the
    //   detached node AFTER Escape cancelled: browsers may fire blur on a
    //   removed focused element);
    // - blank text closes WITHOUT persisting (the keyed remount restores the
    //   original — empty messages are forbidden);
    // - UNCHANGED text needs no request at all;
    // - RACE: blur commits on the SAME click that switches chats, opens a new
    //   chat, or deletes the conversation — the PUT then resolves AFTER the
    //   surface moved on, and applying the returning record would resurrect
    //   the old chat. The edit still persists server-side (and the sidebar
    //   summary updates), but `selected` is only overwritten while the surface
    //   still shows the edited conversation.
    const commitEdit = useCallback(async (index: number, rawText: string) => {
        if (editingIndex() !== index) return;
        const record = selected();
        const text = rawText.trim();
        cancelEdit();
        if (!record || !text || savingEdit()) return;
        if (record.messages[index]?.content === text) return;
        savingEdit(true);
        try {
            const messages: ChatMessage[] = record.messages.map((existing, candidate) =>
                candidate === index ? { ...existing, content: text } : existing
            );
            const result = (await replaceConversationMessages(baseUrl, record.conversationId, { messages })).conversation;
            if (selected()?.conversationId === record.conversationId) selected(result);
            const summary = summaryFromRecord(result);
            chats(chats().map((chat) => (chat.conversationId === summary.conversationId ? summary : chat)));
            error('');
        } catch (reason) {
            error(reason instanceof Error ? reason.message : String(reason));
        } finally {
            savingEdit(false);
        }
    }, [baseUrl, cancelEdit, chats, editingIndex, error, savingEdit, selected]);

    // Send flow: (1) stream the assistant turn from the provider using the ENTIRE
    // conversation history — system prompt included — plus the new user message,
    // rendering deltas live, (2) only after the stream completes, persist the
    // finished pair through the storage API (creating the conversation first when
    // needed), (3) GET the canonical record (skipped on the system-prepend PUT
    // path, which already returns it). The system prompt draft is prepended to
    // history and persisted ONLY when the record does not already lead with a
    // system message; an empty draft adds nothing. A failure before or during
    // streaming saves nothing and restores the composer text for retry.
    // Invoked from the form's onSubmit (event present: prevent the browser's
    // default GET-reload) AND directly from the composer's desktop Enter key
    // (no event: the keydown handler already prevented the newline). The event
    // type follows the styledComponent form's FormEventHandler<HTMLElement>.
    const submit = useCallback(async (event?: React.FormEvent<HTMLElement>) => {
        event?.preventDefault();
        const text = message().trim();
        const chosenModel = model();
        if (!text || !chosenModel || loading()) return;

        loading(true);
        error('');
        // Hand the composer text to the pending turn so it renders while streaming.
        pendingUser(text);
        streaming('');
        message('');
        try {
            const record = selected();
            // Prepend the draft prompt only while the record lacks a leading
            // system message; trimmed-empty drafts add nothing.
            const prompt = record?.messages[0]?.role === 'system' ? '' : systemPrompt().trim();
            const systemPrefix: ChatMessage[] = prompt ? [{ role: 'system', content: prompt }] : [];
            // Full history (system prompt included) goes to whichever model is
            // selected, even if earlier turns were produced by a different model.
            const history: ChatMessage[] = [
                ...systemPrefix,
                ...(record?.messages ?? []),
                { role: 'user', content: text }
            ];
            const reply = await streamProviderChatCompletion(
                providerUrl,
                chosenModel,
                history,
                (content) => streaming(content)
            );

            // Per-message attribution: the assistant turn records the model that
            // produced it so every response stays marked after reload.
            const assistantMessage: ChatMessage = { role: 'assistant', content: reply.content, model: chosenModel };
            let result: ConversationRecord;
            if (!record) {
                // New chat: create, then append. The conversation starts EMPTY, so
                // the append order is exactly [system?, user, assistant].
                const conversationId = (await createConversation(baseUrl, { model: chosenModel })).conversationId;
                await addToConversation(baseUrl, conversationId, {
                    // The stream completed: persist the pending user turn together
                    // with the assistant reply so storage holds completed pairs.
                    messages: [...systemPrefix, { role: 'user', content: text }, assistantMessage],
                    model: chosenModel,
                    ...(reply.usage ? { usage: reply.usage } : {})
                });
                result = (await fetchConversation(baseUrl, conversationId)).conversation;
            } else if (systemPrefix.length > 0) {
                // Existing chat gaining its FIRST system prompt: the append POST
                // can only attach to the END, so the whole history is replaced
                // through the identified PUT to keep the prompt at index 0.
                result = (await replaceConversationMessages(baseUrl, record.conversationId, {
                    messages: [...systemPrefix, ...record.messages, { role: 'user', content: text }, assistantMessage]
                })).conversation;
            } else {
                // Regular turn on an existing chat: append the completed pair,
                // then GET the canonical record back.
                await addToConversation(baseUrl, record.conversationId, {
                    messages: [{ role: 'user', content: text }, assistantMessage],
                    model: chosenModel,
                    ...(reply.usage ? { usage: reply.usage } : {})
                });
                result = (await fetchConversation(baseUrl, record.conversationId)).conversation;
            }
            selected(result);
            // The draft prompt is now persisted (or was never needed) — clear
            // it and its editor, returning the system turn to the persisted
            // message's chrome (or the "no prompt" placeholder).
            systemPrompt('');
            cancelSystemPromptDraft();
            // A fresh record replaced the history (the PUT prepend path can
            // even shift indices), so re-seed turn collapse: the just-finished
            // assistant reply stays expanded, every earlier turn folds.
            collapsedTurns(defaultCollapsedIndices(result.messages));
            // A completed turn makes this model the browser's remembered last-used one.
            rememberModel(chosenModel);
            pendingUser('');
            streaming('');
            const summary = summaryFromRecord(result);
            const current = chats();
            const next = current.some((chat) => chat.conversationId === summary.conversationId)
                ? current.map((chat) => (chat.conversationId === summary.conversationId ? summary : chat))
                : [summary, ...current];
            chats(next);
        } catch (reason) {
            error(reason instanceof Error ? reason.message : String(reason));
            // Restore the draft so a failed stream can be retried without retyping.
            message(text);
            pendingUser('');
            streaming('');
        } finally {
            loading(false);
        }
    }, [baseUrl, providerUrl, cancelSystemPromptDraft, chats, collapsedTurns, error, loading, message, model, pendingUser, selected, streaming, systemPrompt]);

    // Fold/unfold one message turn. Pure view state: adds the index to the
    // collapsed set or removes it; no network call is ever involved.
    const toggleTurnCollapse = useCallback((index: number) => {
        collapsedTurns(
            collapsedTurns().includes(index)
                ? collapsedTurns().filter((candidate) => candidate !== index)
                : [...collapsedTurns(), index]
        );
    }, [collapsedTurns]);

    // Build sidebar nodes from the latest compact summaries. Every entry is a
    // ChatEntry positioning context holding TWO sibling controls: the select
    // button (fills the entry) and the "x" delete control (absolutely pinned
    // to the entry's top-right corner). The x is NOT nested inside the select
    // button (nested interactive elements would be invalid HTML — and clicks
    // would bubble into a chat selection).
    const chatNodes: React.ReactNode[] = [];
    arrayEach(chats(), ({ value: chat }) => {
        chatNodes.push(
            <ChatEntry key={chat.conversationId} data-testid={`chat-entry-${chat.conversationId}`}>
                <ChatButton
                    type="button"
                    onClick={() => void selectChat(chat.conversationId)}
                    aria-pressed={selected()?.conversationId === chat.conversationId}
                    data-testid={`chat-tab-${chat.conversationId}`}
                >
                    <strong>{chat.title}</strong>
                    <Metadata>{chat.messageCount} messages · {chat.status}</Metadata>
                </ChatButton>
                <ConversationDeleteButton
                    type="button"
                    onClick={() => void deleteChat(chat.conversationId)}
                    disabled={deleting() || loading()}
                    aria-label="Delete conversation"
                    title="Delete conversation"
                    data-testid={`delete-chat-${chat.conversationId}`}
                >
                    <span aria-hidden="true">×</span>
                </ConversationDeleteButton>
            </ChatEntry>
        );
    });

    // Build model dropdown options from the provider catalog. If the recorded model
    // of the selected conversation is missing from the catalog it stays selectable
    // so the conversation remains usable with its historical model.
    const catalog = models();
    const chosenModel = model();
    const modelOptions = chosenModel && !catalog.includes(chosenModel) ? [chosenModel, ...catalog] : catalog;

    // Render only the selected record; a new chat remains an empty composer until submitted.
    const currentMessages = selected()?.messages ?? [];
    // A pending turn (sent but not yet persisted) renders after the stored messages.
    const hasPendingTurn = pendingUser().length > 0;
    // The local-draft system turn yields to the RENDERED system message turn
    // once the record leads with a persisted system message.
    const hasPersistedSystemPrompt = selected()?.messages[0]?.role === 'system';
    // While the draft is empty the system turn's bubble is the literal
    // placeholder "no prompt"; the copy action only exists with real text.
    const systemPromptEmpty = systemPrompt().trim() === '';
    // The draft turn's affordances follow the same rules as message turns:
    // none while a turn streams or a conversation delete is in flight.
    const canEditSystemPrompt = !loading() && !deleting();

    // Options handed to the module-level message renderer; rebuilt every render
    // so the closures always see the latest accessor state.
    const messageOptions: MessageListOptions = {
        editingIndex: editingIndex(),
        // No edit affordances while a turn streams or a delete is in flight.
        canEdit: !loading() && !deleting(),
        onEditStart: startEdit,
        onEditCommit: (index, text) => void commitEdit(index, text),
        onEditCancel: cancelEdit,
        onMessageDelete: (index) => void deleteMessage(index),
        onMessageCopy: (content) => void copyMessage(content),
        collapsedTurns: collapsedTurns(),
        onToggleTurnCollapse: toggleTurnCollapse
    };

    return (
        <Page data-testid="chat-assistant">
            <Header>
                <HeaderLead>
                    <SidebarToggle
                        type="button"
                        onClick={() => sidebarOpen(!sidebarOpen())}
                        aria-expanded={sidebarOpen()}
                        aria-controls="chat-sidebar-panel"
                        aria-label="Toggle conversations"
                        data-testid="sidebar-toggle"
                    >
                        <span aria-hidden="true">☰</span>
                    </SidebarToggle>
                    {/* The header title is the SELECTED chat's title; the product
                        name is the new-chat fallback (non-interactive). Clicking
                        the title itself turns the h1 CONTENTEDITABLE (inline
                        rename — no dialog, no input): BLUR or ENTER commits the
                        trimmed text through the identified PUT, ESCAPE cancels
                        (keyed remount reverts the DOM). Titles are single-line,
                        so Enter commits instead of inserting a break. */}
                    {selected() === null ? (
                        <HeaderTitle data-testid="chat-title">Chat Assistant</HeaderTitle>
                    ) : editingTitle() ? (
                        <HeaderTitle
                            key="edit"
                            interactive
                            role="textbox"
                            aria-multiline="false"
                            aria-label="Conversation title"
                            contentEditable
                            suppressContentEditableWarning
                            data-editing="true"
                            onBlur={(event) => void saveTitle(editableTextContent(event.currentTarget))}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                    event.preventDefault();
                                    event.currentTarget.blur();
                                } else if (event.key === 'Escape') {
                                    event.preventDefault();
                                    cancelTitleEdit();
                                }
                            }}
                            data-testid="chat-title"
                        >
                            {selected()!.title}
                        </HeaderTitle>
                    ) : (
                        <HeaderTitle
                            key="view"
                            interactive
                            onClick={(event) => startTitleEdit(textOffsetFromPoint(event.clientX, event.clientY, event.currentTarget))}
                            title="Rename conversation"
                            data-testid="chat-title"
                        >
                            {selected()!.title}
                        </HeaderTitle>
                    )}
                </HeaderLead>
                {/* No header actions: conversation deletion lives on each sidebar
                    entry's "x" (top-right corner of the entry) and the model
                    picker is the clickable text above the composer input. */}
            </Header>
            <Workspace>
                {/* Scrim sits before the sidebar so the drawer paints above it. */}
                <SidebarScrim open={sidebarOpen()} onClick={() => sidebarOpen(false)} data-testid="sidebar-scrim" />
                {/* `open` slides the mobile drawer; md+ CSS ignores it (static column). */}
                <Sidebar open={sidebarOpen()} id="chat-sidebar-panel" data-open={sidebarOpen()} data-testid="chat-sidebar">
                    <NewChatButton type="button" onClick={startNewChat} data-testid="new-chat-button">
                        New chat
                    </NewChatButton>
                    <SidebarHeading>
                        <span>Conversations</span>
                        <Metadata>{chats().length}</Metadata>
                    </SidebarHeading>
                    {chatNodes.length > 0 ? chatNodes : <Metadata data-testid="empty-chat-list">No chats yet.</Metadata>}
                </Sidebar>
                <Conversation>
                    <MessageList data-testid="message-list">
                        {/* The system prompt turn leads every chat — a regular
                            LEFT-aligned row exactly like the assistant turns.
                            While the record has NO leading system message this
                            is the local-draft form: the bubble carries the
                            saved draft or the literal placeholder "no prompt",
                            and the ONLY affordance is the edit pen (plus a copy
                            action once real draft text exists) — clicking
                            EITHER (or the words) makes the BUBBLE ITSELF the
                            inline editor every turn uses (blur saves the
                            draft locally, Escape cancels), and NO delete cross
                            ever (the system prompt cannot be removed). Once
                            the record leads with a persisted system message,
                            renderMessages draws that turn instead and this
                            block disappears. */}
                        {!hasPersistedSystemPrompt && (
                            <SystemTurn data-testid="system-prompt-turn">
                                <TurnHeaderRow>
                                    <TurnHeaderLead>
                                        {/* Plain span, NOT a collapse toggle — a
                                            local draft has nothing to fold. */}
                                        <TurnLabelText data-testid="system-prompt-label">system</TurnLabelText>
                                    </TurnHeaderLead>
                                </TurnHeaderRow>
                                {editingSystemPrompt() ? (
                                    // The bubble IS the editor (contentEditable
                                    // — no textarea/input): BLUR commits the
                                    // DOM text locally (blank → "no prompt"),
                                    // ESCAPE cancels. Keyed 'edit' so the
                                    // remount on exit reverts the DOM. While
                                    // EMPTY the editable surface shows nothing
                                    // (contentEditable has no placeholder);
                                    // the bubble chrome keeps it discoverable.
                                    <SystemMessage
                                        key="edit"
                                        empty={systemPromptEmpty}
                                        role="textbox"
                                        aria-multiline="true"
                                        aria-label="Edit system prompt"
                                        contentEditable
                                        suppressContentEditableWarning
                                        data-editing="true"
                                        onBlur={(event) => saveSystemPromptDraft(editableTextContent(event.currentTarget))}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Escape') {
                                                event.preventDefault();
                                                cancelSystemPromptDraft();
                                            }
                                        }}
                                        data-empty={systemPromptEmpty}
                                        data-testid="system-prompt-value"
                                    >
                                        {systemPrompt()}
                                    </SystemMessage>
                                ) : (
                                    // Click the WORDS to edit directly (the
                                    // bubble becomes contentEditable, exactly
                                    // like every turn's pen) — works even on
                                    // the "no prompt" placeholder. Inert while
                                    // a turn streams or a delete runs.
                                    <SystemMessage
                                        key="view"
                                        empty={systemPromptEmpty}
                                        editable={canEditSystemPrompt}
                                        onClick={(event) => {
                                            if (canEditSystemPrompt) startSystemPromptEdit(textOffsetFromPoint(event.clientX, event.clientY, event.currentTarget));
                                        }}
                                        title={canEditSystemPrompt ? 'Click to edit' : undefined}
                                        data-empty={systemPromptEmpty}
                                        data-testid="system-prompt-value"
                                    >
                                        {systemPromptEmpty ? 'no prompt' : systemPrompt()}
                                    </SystemMessage>
                                )}
                                {/* The draft turn's copy + pen pair mirrors the
                                    message-turn rule: it STAYS RENDERED while
                                    the draft's own editor is open, greyed out +
                                    disabled instead of disappearing (the
                                    producing-chrome-never-disappears rule).
                                    Copy still exists only when there is real
                                    saved draft text. */}
                                {canEditSystemPrompt && (
                                    <TrailingControls>
                                        <TurnActionPair>
                                            {/* Copy mirrors the per-message
                                                action (immediately LEFT of
                                                the pen) but exists only
                                                when there is real draft
                                                text to copy. */}
                                            {!systemPromptEmpty && (
                                                <TurnIconButton
                                                    type="button"
                                                    greyed={editingSystemPrompt()}
                                                    disabled={editingSystemPrompt()}
                                                    onClick={() => void copyMessage(systemPrompt())}
                                                    aria-label="Copy system prompt"
                                                    title="Copy system prompt"
                                                    data-testid="copy-system-prompt"
                                                >
                                                    <span aria-hidden="true">⧉</span>
                                                </TurnIconButton>
                                            )}
                                            <TurnIconButton
                                                type="button"
                                                greyed={editingSystemPrompt()}
                                                disabled={editingSystemPrompt()}
                                                onClick={() => startSystemPromptEdit(null)}
                                                aria-label="Edit system prompt"
                                                title="Edit system prompt"
                                                data-testid="edit-system-prompt"
                                            >
                                                <span aria-hidden="true">✎</span>
                                            </TurnIconButton>
                                        </TurnActionPair>
                                    </TrailingControls>
                                )}
                            </SystemTurn>
                        )}
                        {currentMessages.length > 0 || hasPendingTurn ? (
                            <>
                                {renderMessages(currentMessages, messageOptions)}
                                {hasPendingTurn && (
                                    <UserTurn>
                                        {/* In-flight turns carry the same top-left
                                            attribution label as persisted ones (plain
                                            span — they cannot collapse yet), so the
                                            turn chrome does not jump on completion. */}
                                        <TurnHeaderRow>
                                            <TurnHeaderLead alignRight>
                                                <TurnLabelText>user</TurnLabelText>
                                            </TurnHeaderLead>
                                        </TurnHeaderRow>
                                        <UserMessage data-testid="pending-user-message">{pendingUser()}</UserMessage>
                                    </UserTurn>
                                )}
                                {hasPendingTurn && (
                                    <AssistantTurn>
                                        <TurnHeaderRow>
                                            <TurnHeaderLead>
                                                {/* The in-flight response is marked in its top-left corner with the model currently producing it. */}
                                                <TurnLabelText data-testid="streaming-message-model">{modelLabel(chosenModel)}</TurnLabelText>
                                            </TurnHeaderLead>
                                        </TurnHeaderRow>
                                        <AssistantMessage data-testid="streaming-message">{streaming()}</AssistantMessage>
                                    </AssistantTurn>
                                )}
                            </>
                        ) : (
                            <EmptyState data-testid="empty-chat-state">
                                <strong>Start a conversation</strong>
                                <span>Ask the assistant anything to create your first chat.</span>
                            </EmptyState>
                        )}
                    </MessageList>
                    {error() && <ErrorBanner data-testid="chat-error">{error()}</ErrorBanner>}
                    {/* No "Model: ..." strip: the selected model is the text
                        above the input, and each assistant turn's top-left
                        label already attributes its producing model. */}
                    <Composer
                        onSubmit={submit}
                        // Focus-within gating for the embedded send arrow: show it
                        // when focus ENTERS the composer; hide it only when
                        // focus LEAVES the form entirely (moving among the
                        // input, the arrow, and the model select keeps it
                        // visible — otherwise clicking the arrow would blur
                        // the input first and unmount it before its click).
                        onFocus={() => composerFocus(true)}
                        onBlur={(event) => {
                            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) composerFocus(false);
                        }}
                        data-testid="chat-composer"
                    >
                        {/* The model selection as a TEXT line above the input:
                            the stripped model name, clickable — the invisible
                            native select overlays exactly this text and opens
                            the real dropdown on click. Always visible. */}
                        <ModelPicker data-testid="model-picker">
                            <ModelText data-testid="model-label">
                                {chosenModel ? modelLabel(chosenModel) : catalog.length === 0 ? 'No models available' : 'Select model'}
                            </ModelText>
                            <ModelSelect
                                value={chosenModel}
                                onChange={(event) => {
                                    model(event.target.value);
                                    // An explicit pick is immediately the remembered last-used model.
                                    rememberModel(event.target.value);
                                }}
                                aria-label="Select model"
                                data-testid="model-select"
                                disabled={loading() || catalog.length === 0}
                            >
                                {catalog.length === 0
                                    ? <option value="">No models available</option>
                                    : modelOptions.map((id) => (
                                        // Values keep the full provider-routed id; labels strip the prefix.
                                        <option key={id} value={id}>{modelLabel(id)}</option>
                                    ))}
                            </ModelSelect>
                        </ModelPicker>
                        <ComposerField data-testid="chat-input-field">
                            <MessageInput
                                value={message()}
                                onChange={(event) => {
                                    message(event.target.value);
                                    resizeMessageInput(event.currentTarget);
                                }}
                                onKeyDown={(event) => {
                                    // DESKTOP: Enter submits (identical to the send
                                    // arrow; submit() guards empty text/in-flight
                                    // turns itself) and the newline is suppressed.
                                    // Shift+Enter keeps the textarea's newline
                                    // default, and MOBILE (<md) always keeps it so
                                    // the on-screen keyboard's return key grows the
                                    // draft. isComposing guards IME confirmation
                                    // (e.g. Japanese input) which also fires Enter.
                                    if (event.nativeEvent.isComposing || event.key !== 'Enter' || event.shiftKey) return;
                                    if (!isDesktopViewport()) return;
                                    event.preventDefault();
                                    void submit();
                                }}
                                placeholder="Message the assistant..."
                                aria-label="Message the assistant"
                                data-testid="chat-input"
                                disabled={loading()}
                                // one row by default: the browser's two-row
                                // textarea default would otherwise survive the
                                // resize effect's 'auto' measurement and lock the
                                // empty composer at two rows
                                rows={1}
                            />
                            {/* The ">" send arrow lives INSIDE the input box at
                                its bottom-right corner and exists ONLY while the
                                composer is focused (see onFocus/onBlur above). */}
                            {composerFocus() && (
                                <SendButton
                                    type="submit"
                                    disabled={loading() || !chosenModel || !isString(message()) || !message().trim()}
                                    aria-label="Send message"
                                    title="Send message"
                                    data-testid="send-chat-button"
                                >
                                    <span aria-hidden="true">&gt;</span>
                                </SendButton>
                            )}
                        </ComposerField>
                    </Composer>
                </Conversation>
            </Workspace>
            {/* No rename dialog: renaming is INLINE — the header title h1
                itself becomes contentEditable (see HeaderLead). */}
        </Page>
    );
});
