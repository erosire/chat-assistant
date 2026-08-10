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
// Model selection lives on the split send control ([model|^]):
// - the browser remembers the last model actually used (localStorage);
// - with nothing remembered, a selected chat's recorded model applies;
// - otherwise the first catalog entry sorted by MODEL NAME applies — provider /
//   organisation prefixes are stripped from labels ("zai-org/GLM-5.2-NVFP4" shows
//   as "GLM-5.2-NVFP4") but kept in values for provider routing.
// Conversation management: "New chat" sits at the sidebar's top-left and the
// selected chat can be permanently deleted from the header's top-right delete
// action (identified DELETE). The header title mirrors the selected chat's title
// (derived server-side from the trimmed first line of the first user message)
// and is renameable by clicking the title itself, which opens a dialog box.
// Every assistant response
// is marked in its TOP-LEFT corner with the model that produced it
// (per-message attribution persisted via ChatMessage.model). History is freely
// editable: user and assistant
// messages offer an inline editor (pen icon) and individual deletion (x icon);
// next to the edit pen EVERY turn also carries a copy action (two-squares
// icon) that writes the raw message text to the system clipboard without
// touching storage;
// message edits, message deletes, and renames all replace the ENTIRE history
// through the identified PUT, so the next turn automatically sends the
// edited/shortened history to the provider. Every turn also carries a copy
// action next to the edit pen that writes the raw message text to the system
// clipboard (client-side only, no storage). Every chat is led by a SYSTEM
// prompt: while the conversation has no system message, an editable draft box
// renders at the start of the chat (even empty); a non-empty draft is persisted
// as the leading system message on the next send (and prepended to the
// provider history), after which the system turn behaves like any other turn
// (same inline editor, same copy action, full-history PUT rewrites) EXCEPT it
// cannot be deleted. Every message TURN carries an attribution label in the
// TOP-LEFT corner of the row above its bubble: the producing model's name for
// assistant turns, the literal speaker ("user" / "system" for now) otherwise.
// That label IS the turn's collapse toggle — no chevron glyph ever renders.
// Collapsing folds the turn down to the label plus a one-line preview of its
// first line; clicking the collapsed preview line (the visible "message") or
// the label expands it back. The delete cross stays on the row's right. By
// default EVERY turn starts COLLAPSED except the LATEST assistant reply —
// user turns fold to one-line previews of their questions, system turns fold
// (prompts can be long), and each older assistant reply folds once a newer
// reply lands; the collapsed set is re-seeded from the fresh record's default
// indices whenever a record loads or the history is replaced. Collapse is
// session-level UI state only. Composer keyboard rules: on DESKTOP (md+) Enter submits the
// message and Shift+Enter inserts a newline; on MOBILE (below md) Enter always
// inserts a newline so the on-screen keyboard's return key only grows the
// draft — submission stays on the split send button. The sidebar is a
// static column on md+ screens and a toggleable drawer below the md breakpoint.
// The message list ALWAYS follows the conversation bottom: typing in the
// composer (the field grows and squeezes the list), the sent message's
// pending bubble, every streamed token of the reply, and every fresh record
// (chat selection, completed turn, edited history) re-pin the list's scroll
// position to its end — the list is the page's only scrolling surface (see
// the viewport-locked Page).
import React, { useCallback, useEffect } from 'react';
import { arrayEach, isString } from '@presource/core';
import { styledComponent, useStateHook } from '@presource/react';
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

// Header title shows the SELECTED chat's title as plain text only when nothing
// is selected (new chat): the product-name fallback is not interactive.
const HeaderTitle = styledComponent('h1', {
    margin: 0,
    fontSize: 20,
    lineHeight: 1.2,
    fontWeight: 700,
    letterSpacing: 0.2,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
});

// With a chat selected the header title IS the edit affordance: clicking it
// opens the rename dialog, so no separate pen is needed. It visually matches
// the plain HeaderTitle; only the pointer cursor hints at interactivity.
const HeaderTitleButton = styledComponent('button', {
    margin: 0,
    padding: 0,
    border: 'none',
    backgroundColor: 'transparent',
    color: 'inherit',
    font: 'inherit',
    fontSize: 20,
    lineHeight: 1.2,
    fontWeight: 700,
    letterSpacing: 0.2,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    textAlign: 'left'
}) as unknown as React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>>;

// Full-screen dimming layer behind the rename dialog; clicking it cancels.
const DialogScrim = styledComponent('div', {
    position: 'fixed',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    zIndex: 40
});

// The rename dialog box: compact centered panel with the input and actions.
// zIndex 40 lifts it above the mobile sidebar drawer (20) and scrim (10).
const TitleDialog = styledComponent('div', {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    width: 'min(420px, 100%)',
    padding: 16,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 10,
    backgroundColor: COLORS.panel
});

// Dialog heading stays quiet: this dialog does exactly one thing.
const DialogHeading = styledComponent('h2', {
    margin: 0,
    fontSize: 14,
    fontWeight: 700,
    color: COLORS.text
});

const TitleInput = styledComponent('input', {
    width: '100%',
    boxSizing: 'border-box',
    padding: '8px 10px',
    border: `1px solid ${COLORS.border}`,
    borderRadius: 6,
    backgroundColor: COLORS.page,
    color: COLORS.text,
    font: 'inherit',
    outline: 'none'
}) as unknown as React.FC<React.InputHTMLAttributes<HTMLInputElement>>;

// Dialog actions right-align in a ROW on desktop (md+) per common dialog
// convention, but STACK full-width on mobile (xs): narrow screens read better
// with each button on its own line (stacking is a media-query concern — see
// styleMedia in @presource/react — so jsdom cannot observe it via
// getComputedStyle).
const DialogActions = styledComponent('div', {
    display: 'flex',
    flexDirection: () => ({ xs: 'column', md: 'row' }),
    alignItems: () => ({ xs: 'stretch', md: 'center' }),
    justifyContent: 'flex-end',
    gap: 8
});

// Header actions (just the conversation delete) stay grouped on the header's
// right side; "New chat" lives in the sidebar and the model picker lives on
// the split send control in the composer instead.
const HeaderActions = styledComponent('div', {
    display: 'flex',
    alignItems: 'center',
    gap: 8
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

// Each conversation button presents the server summary without rendering message content in the sidebar.
const ChatButton = styledComponent('button', {
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 4,
    padding: 12,
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

// Turn wrappers own alignment and max-width so each bubble can sit together
// with its turn chrome (attribution label, edit controls, inline editor)
// inside one flex column — the bubbles themselves no longer self-align.
const UserTurn = styledComponent('div', {
    alignSelf: 'flex-end',
    maxWidth: 'min(760px, 86%)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: 4
});

const AssistantTurn = styledComponent('div', {
    alignSelf: 'flex-start',
    maxWidth: 'min(760px, 86%)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 4
});

// Message bubbles are separate styled elements so role-dependent styling never
// relies on inline objects. Width fills the turn wrapper.
const UserMessage = styledComponent('article', {
    width: '100%',
    padding: '12px 16px',
    borderRadius: '16px 16px 4px 16px',
    backgroundColor: COLORS.user,
    color: COLORS.text,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    lineHeight: 1.5
});

const AssistantMessage = styledComponent('article', {
    width: '100%',
    padding: '12px 16px',
    borderRadius: '16px 16px 16px 4px',
    backgroundColor: COLORS.assistant,
    color: COLORS.text,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    lineHeight: 1.5
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
const TurnHeaderRow = styledComponent('div', {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
    padding: '0 4px',
    width: '100%',
    minHeight: 22,
    boxSizing: 'border-box'
});

// Left group of the header row: label + preview share the row's flex space.
const TurnHeaderLead = styledComponent('div', {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 6
});

// Top-left attribution label of a persisted turn: the producing model's
// stripped name for assistant turns, the literal speaker ("user" / "system"
// for now) otherwise. The label IS the collapse toggle — clicking it folds or
// unfolds the turn, and NO chevron glyph ever accompanies it. Typography
// lives on the inner TurnLabelText so in-flight turns (which cannot collapse
// yet) can render the identical label as a plain span.
const TurnLabel = styledComponent('button', {
    display: 'inline-flex',
    alignItems: 'center',
    minWidth: 0,
    padding: 0,
    border: 'none',
    borderRadius: 4,
    backgroundColor: 'transparent',
    cursor: 'pointer',
    font: 'inherit'
}) as unknown as React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>>;

// Shared typography of the turn label: used inside TurnLabel for persisted
// turns and rendered bare for the in-flight pending/streaming turns.
const TurnLabelText = styledComponent('span', {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: 700,
    lineHeight: 1.3
});

// One-line preview replacing a collapsed bubble: first line of the message,
// muted, ellipsis-truncated. The preview is CLICKABLE — since no chevron
// exists, clicking the visible collapsed "message" expands the turn again.
const TurnPreview = styledComponent('span', {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 1.4,
    cursor: 'pointer'
});

// The per-message delete control (x icon in the DeleteRow above the bubble).
// The glyph stays plain text (U+00D7 MULTIPLICATION SIGN — text presentation,
// not emoji) with the accessible label on the button itself.
const MessageDeleteButton = styledComponent('button', {
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
    cursor: 'pointer',
    font: 'inherit',
    fontSize: 13,
    lineHeight: 1
}) as unknown as React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>>;

// Icon-only affordance for the per-message edit action (the pen). The glyph
// stays plain text (U+270E LOWER RIGHT PENCIL — text presentation, not emoji)
// with the accessible label on the button itself.
const TurnIconButton = styledComponent('button', {
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
    cursor: 'pointer',
    font: 'inherit',
    fontSize: 13,
    lineHeight: 1
}) as unknown as React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>>;

// Inline editor for the free history-editing flow: fills the turn wrapper,
// three rows tall by default, and keeps the composer keyboard language uniform.
const EditArea = styledComponent('textarea', {
    width: '100%',
    minWidth: 'min(520px, 72vw)',
    minHeight: 'calc(1.4em * 3 + 24px)',
    resize: 'vertical',
    overflowY: 'auto',
    padding: '12px 14px',
    border: `1px solid ${COLORS.border}`,
    borderRadius: 8,
    backgroundColor: COLORS.page,
    color: COLORS.text,
    font: 'inherit',
    lineHeight: 1.4,
    outline: 'none'
}) as unknown as React.FC<React.TextareaHTMLAttributes<HTMLTextAreaElement>>;

// Save/Cancel controls of the inline editor sit compactly under the textarea.
const EditActions = styledComponent('div', {
    display: 'flex',
    alignItems: 'center',
    gap: 8
});

// System prompt DRAFT box shown at the START of every chat whose record does
// not already lead with a system message — rendered even while empty. Typed
// text stays local until the next send: on submit a non-empty draft becomes
// the conversation's leading `system` message (prepended to the provider
// history AND persisted with the turn), after which this box is replaced by
// the rendered system turn (editable + copyable, never deletable). Styling
// echoes the composer input, slightly de-emphasised (panelStrong, smaller font).
const SystemPromptBox = styledComponent('textarea', {
    width: '100%',
    boxSizing: 'border-box',
    minHeight: 'calc(1.4em * 2 + 24px)',
    resize: 'vertical',
    overflowY: 'auto',
    padding: '12px 14px',
    border: `1px solid ${COLORS.border}`,
    borderRadius: 8,
    backgroundColor: COLORS.panelStrong,
    color: COLORS.text,
    font: 'inherit',
    fontSize: 13,
    lineHeight: 1.4,
    outline: 'none'
}) as unknown as React.FC<React.TextareaHTMLAttributes<HTMLTextAreaElement>>;

// System turns own a centered column wrapper (like UserTurn/AssistantTurn) so
// the bubble can sit together with its turn chrome (copy + edit pair below,
// inline editor filling the wrapper while editing).
const SystemTurn = styledComponent('div', {
    alignSelf: 'center',
    width: 'min(760px, 86%)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4
});

// System messages remain visible but visually subordinate to user and assistant
// turns; the bubble fills the SystemTurn wrapper's width.
const SystemMessage = styledComponent('article', {
    width: '100%',
    boxSizing: 'border-box',
    padding: '8px 12px',
    borderRadius: 8,
    backgroundColor: COLORS.panelStrong,
    color: COLORS.muted,
    fontSize: 13,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere'
});

// Composer separates the editable input from the message list and exposes a stable
// test hook. flexShrink:0 pins it to the conversation column's BOTTOM edge: it
// never shrinks or scrolls away while the message list above absorbs all the
// overflow as the column's only scrolling surface. align-items: flex-start
// keeps the send control pinned to the top of the composer row even when the
// textarea grows to multiple lines.
const Composer = styledComponent('form', {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'flex-start',
    gap: 12,
    padding: 16,
    borderTop: `1px solid ${COLORS.border}`,
    backgroundColor: COLORS.panel
});

// Textarea starts exactly one line high (1.4em line box + 24px vertical padding)
// and grows through eight rows as newlines add content; the explicit CSS
// height avoids the browser's default two-row textarea flash before the resize
// effect runs. Mouse resizing is disabled so the composer height remains
// controlled by the message content. Keyboard behavior (see the onKeyDown
// handler at the render site below): on DESKTOP (md+ viewport) Enter submits
// the message and Shift+Enter inserts a newline; on MOBILE Enter always
// inserts a newline and the split send button performs submission.
const MessageInput = styledComponent('textarea', {
    flex: 1,
    minHeight: 0,
    height: 'calc(1.4em + 24px)',
    maxHeight: 'calc(1.4em * 8 + 24px)',
    resize: 'none',
    overflowY: 'auto',
    padding: '12px 14px',
    border: `1px solid ${COLORS.border}`,
    borderRadius: 8,
    backgroundColor: COLORS.page,
    color: COLORS.text,
    font: 'inherit',
    lineHeight: 1.4,
    outline: 'none'
}) as unknown as React.FC<React.TextareaHTMLAttributes<HTMLTextAreaElement>>;

// Send control group: split control rendered as [{model}|^]. The left half submits
// using the selected model name as its label; the right half ("^") opens the model
// dropdown. Both halves share the accent surface so they read as one control.
const SendGroup = styledComponent('div', {
    display: 'flex',
    alignItems: 'stretch',
    flexShrink: 0
});

// Left half of the send control: the submit button whose label is the model name.
const SendButton = styledComponent('button', {
    minHeight: 42,
    padding: '0 16px',
    border: `1px solid ${COLORS.accentStrong}`,
    borderRadius: '8px 0 0 8px',
    backgroundColor: COLORS.accentStrong,
    color: '#ffffff',
    cursor: 'pointer',
    font: 'inherit',
    fontWeight: 700,
    whiteSpace: 'nowrap'
}) as unknown as React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>>;

// Right half of the send control: the visible "^" caret. A hairline divider
// separates it from the model-name half to communicate the split behavior.
const CaretField = styledComponent('span', {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 42,
    border: `1px solid ${COLORS.accentStrong}`,
    borderLeft: '1px solid rgba(255, 255, 255, 0.35)',
    borderRadius: '0 8px 8px 0',
    backgroundColor: COLORS.accentStrong,
    color: '#ffffff',
    fontWeight: 700,
    lineHeight: 1
});

// Native select layered invisibly over the caret half. Every click on "^" actually
// lands on this select, which opens the real model dropdown; keeping it a native
// <select> preserves keyboard support and the existing data-testid="model-select"
// contract used by the tests (fireEvent.change selects a model by value).
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

// Destructive delete action for the selected conversation, pinned to the
// header's far right; the danger outline separates it from neutral chrome.
const DeleteButton = styledComponent(SecondaryButton, {
    borderColor: 'rgba(255, 156, 156, 0.45)',
    color: COLORS.danger
}) as unknown as React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>>;

// Small metadata labels keep model/status details available without competing with message text.
const Metadata = styledComponent('span', {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 1.3
});

// Model metadata receives its own layout component so the JSX contains no
// inline style object. flexShrink:0 keeps the one-line strip from being
// squeezed between the message list and the pinned composer.
const ModelMetadata = styledComponent(Metadata, {
    display: 'block',
    flexShrink: 0,
    padding: '0 24px 8px'
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
    // Draft text held by the inline editor.
    editingText: string;
    // True while a history-replacement PUT (edit save or message delete) is in flight.
    savingEdit: boolean;
    // Edit affordances are hidden during streaming/deletion; one edit at a time.
    canEdit: boolean;
    onEditStart: (index: number, content: string) => void;
    onEditChange: (text: string) => void;
    onEditCancel: () => void;
    onEditSave: () => void;
    onMessageDelete: (index: number) => void;
    // Copies a message's raw text to the system clipboard (client-side only).
    onMessageCopy: (content: string) => void;
    // Indices of currently collapsed turns (the fresh-record default seeds
    // this set: everything except the latest assistant reply). Pure
    // session-level UI state.
    collapsedTurns: number[];
    onToggleTurnCollapse: (index: number) => void;
};

// Shared inline editor block used by both user and assistant turns; alignment is
// owned by the surrounding turn wrapper. Save replaces the ENTIRE history
// through the identified PUT (see saveEdit), so edited history is exactly what
// the next provider turn receives.
const renderEditor = (options: MessageListOptions): React.ReactNode => (
    <>
        <EditArea
            value={options.editingText}
            onChange={(event) => options.onEditChange(event.target.value)}
            aria-label="Edit message"
            data-testid="edit-message-input"
            autoFocus
        />
        <EditActions>
            <SecondaryButton
                type="button"
                onClick={options.onEditSave}
                disabled={options.savingEdit || options.editingText.trim().length === 0}
                data-testid="edit-message-save"
            >
                {options.savingEdit ? 'Saving...' : 'Save'}
            </SecondaryButton>
            <SecondaryButton type="button" onClick={options.onEditCancel} disabled={options.savingEdit} data-testid="edit-message-cancel">
                Cancel
            </SecondaryButton>
        </EditActions>
    </>
);

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
const renderMessages = (messages: ChatMessage[], options: MessageListOptions): React.ReactNode[] => {
    const nodes: React.ReactNode[] = [];
    arrayEach(messages, ({ index, value: message }) => {
        const key = `${message.role}-${index}`;
        const editing = options.editingIndex === index;
        const collapsed = options.collapsedTurns.includes(index);
        // The pen (edit, controls row under the bubble), the copy action beside
        // it, and the delete cross appear only while idle AND expanded: one
        // edit at a time, none during streaming/conversation deletion, and none
        // while the turn is collapsed (its bubble is hidden).
        const editControl = !collapsed && options.canEdit && options.editingIndex === null ? (
            <TurnIconButton
                type="button"
                onClick={() => options.onEditStart(index, message.content)}
                aria-label="Edit message"
                title="Edit message"
                data-testid={`edit-message-${index}`}
            >
                <span aria-hidden="true">✎</span>
            </TurnIconButton>
        ) : null;
        // The delete cross sits on the RIGHT of the header row above the bubble;
        // SYSTEM messages are the one non-deletable turn: edit + copy still apply.
        const deleteControl = !collapsed && options.canEdit && options.editingIndex === null && message.role !== 'system' ? (
            <MessageDeleteButton
                type="button"
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
        const copyControl = !collapsed && options.canEdit && options.editingIndex === null ? (
            <TurnIconButton
                type="button"
                onClick={() => options.onMessageCopy(message.content)}
                aria-label="Copy message"
                title="Copy message"
                data-testid={`copy-message-${index}`}
            >
                <span aria-hidden="true">⧉</span>
            </TurnIconButton>
        ) : null;
        // Top-left attribution text: the producing model's stripped name for
        // assistant turns WITH per-message attribution (ChatMessage.model);
        // the literal role name otherwise ("user" / "system" for now — a real
        // speaker identity can replace these labels later).
        const speakerLabel = message.role === 'assistant' && message.model !== undefined
            ? modelLabel(message.model)
            : message.role;
        // Header row above the bubble: the attribution label (+ first-line
        // preview while collapsed) LEFT, delete cross RIGHT. The label itself
        // is the collapse toggle — collapsing is pure view state — and renders
        // except while this turn is being edited (the editor occupies the
        // bubble slot). No chevron glyph ever renders beside it.
        const headerRow = !editing ? (
            <TurnHeaderRow>
                <TurnHeaderLead>
                    <TurnLabel
                        type="button"
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
                        // The collapsed "message" is this preview line: clicking
                        // it expands the turn again (there is no chevron to click).
                        <TurnPreview
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
        ) : null;
        if (message.role === 'user') {
            nodes.push(
                <UserTurn key={key} data-testid={`message-turn-${index}`}>
                    {editing ? renderEditor(options) : (
                        <>
                            {headerRow}
                            {!collapsed && <UserMessage>{message.content}</UserMessage>}
                        </>
                    )}
                    {!editing && editControl !== null && (
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
                <AssistantTurn key={key} data-testid={`message-turn-${index}`}>
                    {editing ? renderEditor(options) : (
                        <>
                            {headerRow}
                            {!collapsed && <AssistantMessage>{message.content}</AssistantMessage>}
                        </>
                    )}
                    {!editing && editControl !== null && (
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
                <SystemTurn key={key} data-testid={`message-turn-${index}`}>
                    {editing ? renderEditor(options) : (
                        <>
                            {headerRow}
                            {!collapsed && <SystemMessage>{message.content}</SystemMessage>}
                        </>
                    )}
                    {!editing && editControl !== null && (
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

// Resize the textarea from its content height while capping the visible editor
// at eight rows; resetting height first also shrinks the field after deletion.
const resizeMessageInput = (element: HTMLTextAreaElement): void => {
    element.style.height = 'auto';
    const computed = window.getComputedStyle(element);
    const lineHeight = Number.parseFloat(computed.lineHeight) || 22.4;
    const verticalPadding =
        (Number.parseFloat(computed.paddingTop) || 0) + (Number.parseFloat(computed.paddingBottom) || 0);
    const oneRowHeight = lineHeight + verticalPadding;
    const maxHeight = lineHeight * 8 + verticalPadding;
    const contentHeight = Math.max(element.scrollHeight, oneRowHeight);
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
    // Local draft for the system prompt box, shown ONLY while the selected
    // record lacks a leading system message. On the next send a non-empty draft
    // is persisted as the leading system message (see submit); cleared on new
    // chat, on chat switch, on conversation deletion, and after a send.
    const systemPrompt = useStateHook('');
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
    // Mobile drawer state; at md+ the sidebar is a permanent column and this
    // state is ignored by CSS (the toggle button is display:none there).
    const sidebarOpen = useStateHook(false);
    // Inline history editing: index of the message under edit plus the draft
    // text; `savingEdit` guards the identified PUT that replaces the history.
    const editingIndex = useStateHook<number | null>(null);
    const editingText = useStateHook('');
    const savingEdit = useStateHook(false);
    // Header title rename: the draft plus a dedicated saving flag (the rename
    // rides the same identified PUT, with the history round-tripping unchanged).
    const editingTitle = useStateHook(false);
    const titleDraft = useStateHook('');
    const savingTitle = useStateHook(false);

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

    // Inherit a conversation's recorded model ONLY when the browser has not
    // remembered one yet; the inherited model then becomes the remembered one.
    const applyModelMemory = useCallback((recordModel: string) => {
        if (!readRememberedModel()) {
            model(recordModel);
            rememberModel(recordModel);
        }
    }, [model]);

    // Abandon any half-finished inline edit; shared by chat switching, new chat,
    // deletion, and the editor's own Cancel button.
    const cancelEdit = useCallback(() => {
        editingIndex(null);
        editingText('');
    }, [editingIndex, editingText]);

    // Close the header rename editor; shared by chat switching, new chat,
    // deletion, and the editor's own Cancel button.
    const cancelTitleEdit = useCallback(() => {
        editingTitle(false);
        titleDraft('');
    }, [editingTitle, titleDraft]);

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
            // The system prompt draft belongs to the previous chat's surface,
            // and turn collapse re-seeds from the freshly loaded record (every
            // turn folds except its latest assistant reply).
            systemPrompt('');
            collapsedTurns(defaultCollapsedIndices(record.messages));
            error('');
        } catch (reason) {
            error(reason instanceof Error ? reason.message : String(reason));
        } finally {
            loading(false);
        }
    }, [applyModelMemory, baseUrl, cancelEdit, cancelTitleEdit, collapsedTurns, error, loading, selected, sidebarOpen, systemPrompt]);

    // Reset the surface without creating a server record until the first provider
    // turn completes. The model selection intentionally survives a new chat so the
    // last-used model stays preselected. The button lives in the sidebar, so the
    // mobile drawer closes when a fresh chat starts.
    const startNewChat = useCallback(() => {
        selected(null);
        message('');
        // A fresh chat starts the system prompt draft box empty as well, with
        // no collapsed turns (there is no history to fold yet).
        systemPrompt('');
        collapsedTurns([]);
        error('');
        sidebarOpen(false);
        cancelEdit();
        cancelTitleEdit();
    }, [cancelEdit, cancelTitleEdit, collapsedTurns, error, message, selected, sidebarOpen, systemPrompt]);

    // Permanently delete the selected conversation (identified DELETE): drop its
    // summary from the sidebar and return the surface to the empty new-chat
    // state. The model selection survives, matching startNewChat. Blocked while
    // a turn is streaming so a late-arriving stream cannot resurrect the chat.
    const deleteSelectedChat = useCallback(async () => {
        const conversationId = selected()?.conversationId;
        if (!conversationId || deleting() || loading()) return;
        deleting(true);
        try {
            await deleteConversation(baseUrl, conversationId);
            chats(chats().filter((chat) => chat.conversationId !== conversationId));
            selected(null);
            message('');
            // Deleting returns to a fresh surface: prompt draft + collapse too.
            systemPrompt('');
            collapsedTurns([]);
            cancelEdit();
            cancelTitleEdit();
            error('');
        } catch (reason) {
            error(reason instanceof Error ? reason.message : String(reason));
        } finally {
            deleting(false);
        }
    }, [baseUrl, cancelEdit, cancelTitleEdit, chats, collapsedTurns, deleting, error, loading, message, selected, systemPrompt]);

    // Open the inline editor for one message, seeded with its current content.
    const startEdit = useCallback((index: number, content: string) => {
        editingIndex(index);
        editingText(content);
    }, [editingIndex, editingText]);

    // Remove a single message and persist the shortened history through the same
    // identified PUT the editor uses; the next provider turn automatically sends
    // the shortened history as its context. Guarded by savingEdit like saveEdit
    // so two history rewrites can never race.
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

    // Open the header rename editor seeded with the conversation's current title.
    const startTitleEdit = useCallback(() => {
        titleDraft(selected()?.title ?? '');
        editingTitle(true);
    }, [editingTitle, selected, titleDraft]);

    // Persist a rename through the SAME identified PUT the message editor uses:
    // the history round-trips unchanged while the explicit title wins over the
    // server's first-line derivation. Blocked while a turn streams so a late
    // append-follow-up GET cannot overwrite the rename (and vice versa).
    const saveTitle = useCallback(async () => {
        const record = selected();
        const title = titleDraft().trim();
        if (!record || !title || savingTitle() || loading()) return;
        savingTitle(true);
        try {
            const result = (await replaceConversationMessages(baseUrl, record.conversationId, {
                messages: record.messages,
                title
            })).conversation;
            selected(result);
            const summary = summaryFromRecord(result);
            chats(chats().map((chat) => (chat.conversationId === summary.conversationId ? summary : chat)));
            cancelTitleEdit();
            error('');
        } catch (reason) {
            error(reason instanceof Error ? reason.message : String(reason));
        } finally {
            savingTitle(false);
        }
    }, [baseUrl, cancelTitleEdit, chats, error, loading, savingTitle, selected, titleDraft]);

    // Persist an edit by REPLACING the complete history through the identified
    // PUT. The server returns the canonical record (messageCount/updatedAt and a
    // re-derived title when the first user turn changed), which re-syncs both the
    // selection and the sidebar summary. Turn submission always builds the
    // provider payload from selected().messages, so the next chat message
    // automatically sends the edited history to the model.
    const saveEdit = useCallback(async () => {
        const index = editingIndex();
        const record = selected();
        const text = editingText().trim();
        if (index === null || !record || !text || savingEdit()) return;
        savingEdit(true);
        try {
            const messages: ChatMessage[] = record.messages.map((existing, candidate) =>
                candidate === index ? { ...existing, content: text } : existing
            );
            const result = (await replaceConversationMessages(baseUrl, record.conversationId, { messages })).conversation;
            selected(result);
            const summary = summaryFromRecord(result);
            chats(chats().map((chat) => (chat.conversationId === summary.conversationId ? summary : chat)));
            cancelEdit();
            error('');
        } catch (reason) {
            error(reason instanceof Error ? reason.message : String(reason));
        } finally {
            savingEdit(false);
        }
    }, [baseUrl, cancelEdit, chats, editingIndex, editingText, error, savingEdit, selected]);

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
            // The draft prompt is now persisted (or was never needed) — clear it.
            systemPrompt('');
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
    }, [baseUrl, providerUrl, chats, collapsedTurns, error, loading, message, model, pendingUser, selected, streaming, systemPrompt]);

    // Fold/unfold one message turn. Pure view state: adds the index to the
    // collapsed set or removes it; no network call is ever involved.
    const toggleTurnCollapse = useCallback((index: number) => {
        collapsedTurns(
            collapsedTurns().includes(index)
                ? collapsedTurns().filter((candidate) => candidate !== index)
                : [...collapsedTurns(), index]
        );
    }, [collapsedTurns]);

    // Build sidebar nodes from the latest compact summaries.
    const chatNodes: React.ReactNode[] = [];
    arrayEach(chats(), ({ value: chat }) => {
        chatNodes.push(
            <ChatButton
                key={chat.conversationId}
                type="button"
                onClick={() => void selectChat(chat.conversationId)}
                aria-pressed={selected()?.conversationId === chat.conversationId}
                data-testid={`chat-tab-${chat.conversationId}`}
            >
                <strong>{chat.title}</strong>
                <Metadata>{chat.messageCount} messages · {chat.status}</Metadata>
            </ChatButton>
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
    // The draft box yields to the rendered system turn once the record leads
    // with a persisted system message.
    const hasPersistedSystemPrompt = selected()?.messages[0]?.role === 'system';

    // Options handed to the module-level message renderer; rebuilt every render
    // so the closures always see the latest accessor state.
    const messageOptions: MessageListOptions = {
        editingIndex: editingIndex(),
        editingText: editingText(),
        savingEdit: savingEdit(),
        // No edit affordances while a turn streams or a delete is in flight.
        canEdit: !loading() && !deleting(),
        onEditStart: startEdit,
        onEditChange: (text) => editingText(text),
        onEditCancel: cancelEdit,
        onEditSave: () => void saveEdit(),
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
                        name is the new-chat fallback. Clicking the title itself
                        (no separate pen) opens the rename dialog below. */}
                    {selected() !== null ? (
                        <HeaderTitleButton
                            type="button"
                            onClick={startTitleEdit}
                            disabled={loading()}
                            title="Rename conversation"
                            data-testid="chat-title"
                        >
                            {selected()!.title}
                        </HeaderTitleButton>
                    ) : (
                        <HeaderTitle data-testid="chat-title">Chat Assistant</HeaderTitle>
                    )}
                </HeaderLead>
                <HeaderActions>
                    <DeleteButton
                        type="button"
                        onClick={() => void deleteSelectedChat()}
                        disabled={!selected() || deleting() || loading()}
                        data-testid="delete-chat-button"
                    >
                        {deleting() ? 'Deleting...' : 'Delete'}
                    </DeleteButton>
                </HeaderActions>
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
                        {/* The system prompt DRAFT box leads every chat (even
                            empty) until the record persists a leading system
                            message — then that message renders as a regular
                            (non-deletable) system turn instead. A non-empty
                            draft is persisted + sent upstream on the next send. */}
                        {!hasPersistedSystemPrompt && (
                            <SystemPromptBox
                                value={systemPrompt()}
                                onChange={(event) => systemPrompt(event.target.value)}
                                placeholder="System prompt (optional)"
                                aria-label="System prompt"
                                data-testid="system-prompt-input"
                            />
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
                                            <TurnHeaderLead>
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
                    {selected() && (
                        <ModelMetadata data-testid="chat-model">
                            Model: {selected()!.model}
                        </ModelMetadata>
                    )}
                    <Composer onSubmit={submit} data-testid="chat-composer">
                        <MessageInput
                            value={message()}
                            onChange={(event) => {
                                message(event.target.value);
                                resizeMessageInput(event.currentTarget);
                            }}
                            onKeyDown={(event) => {
                                // DESKTOP: Enter submits (identical to the send
                                // button; submit() guards empty text/in-flight
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
                        />
                        <SendGroup data-testid="send-group">
                            <SendButton
                                type="submit"
                                disabled={loading() || !chosenModel || !isString(message()) || !message().trim()}
                                data-testid="send-chat-button"
                            >
                                {loading() ? 'Sending...' : chosenModel ? modelLabel(chosenModel) : 'Send'}
                            </SendButton>
                            <CaretField data-testid="model-caret">
                                <span aria-hidden="true">^</span>
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
                            </CaretField>
                        </SendGroup>
                    </Composer>
                </Conversation>
            </Workspace>
            {/* Rename dialog, opened by clicking the header title. Enter saves,
                Escape or a scrim click cancels; the scrim stops propagation at
                the dialog box so clicks inside never dismiss accidentally. */}
            {selected() !== null && editingTitle() && (
                <DialogScrim onClick={cancelTitleEdit} data-testid="title-dialog-scrim">
                    <TitleDialog
                        role="dialog"
                        aria-modal="true"
                        aria-label="Rename conversation"
                        data-testid="title-dialog"
                        onClick={(event) => event.stopPropagation()}
                    >
                        <DialogHeading>Rename conversation</DialogHeading>
                        <TitleInput
                            value={titleDraft()}
                            onChange={(event) => titleDraft(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter' && titleDraft().trim().length > 0 && !savingTitle()) {
                                    void saveTitle();
                                } else if (event.key === 'Escape') {
                                    cancelTitleEdit();
                                }
                            }}
                            aria-label="Conversation title"
                            data-testid="chat-title-input"
                            autoFocus
                        />
                        <DialogActions>
                            <SecondaryButton type="button" onClick={cancelTitleEdit} disabled={savingTitle()} data-testid="chat-title-cancel">
                                Cancel
                            </SecondaryButton>
                            <SecondaryButton
                                type="button"
                                onClick={() => void saveTitle()}
                                disabled={savingTitle() || titleDraft().trim().length === 0}
                                data-testid="chat-title-save"
                            >
                                {savingTitle() ? 'Saving...' : 'Save'}
                            </SecondaryButton>
                        </DialogActions>
                    </TitleDialog>
                </DialogScrim>
            )}
        </Page>
    );
});
