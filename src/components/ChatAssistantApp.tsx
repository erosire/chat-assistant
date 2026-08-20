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
// the bubble ITSELF into the editor (contentEditable, auto-focused with
// preventScroll:true so the list NEVER jumps — default focus() scrolls the
// provisional offset-0 caret into view and in a long chat snapped the list
// to the message's top; caret RESTORED ONTO THE CLICKED WORD via the
// captured click-point offset — see textOffsetFromPoint; an unresolvable
// click point places the caret at the text end). There is NO separate edit
// button — the words themselves are the trigger (the old edit pen was retired
// as redundant). The edit SAVES AUTOMATICALLY ON BLUR (the
// bubble's DOM text commits through the whole-history PUT; blank text just
// restores the original) and ESCAPE cancels (a keyed bubble remount reverts
// the DOM — React reconciliation cannot reset a mutated contentEditable node).
// While ANY turn is being edited or a new reply is generating NO persisted-turn
// chrome disappears: the header row —
// the producing-model/speaker label — stays rendered (only the edited turn's
// collapse toggle greys out + disables, so folding cannot unmount the live
// editor), and EVERY turn's copy and delete icons (the system prompt draft's
// copy included) stay rendered but greyed out + natively disabled — one edit
// at a time, visible. Conversation deletion and prompt persistence still hide
// those icons entirely; provider waiting/streaming leaves the whole dashboard
// enabled and fully styled instead of making the UI look frozen.
// Messages remain individually deletable (x icon);
// EVERY turn also carries a copy action (two-squares
// icon) that writes the raw message text to the system clipboard without
// touching storage. The controls row under each bubble is
// BOTTOM-STICKY within its own turn: while a turn's content extends beyond
// the message list's bottom scrollport edge the row rides the list's visible
// bottom edge, following the scroll as a TRANSPARENT floating strip (an
// opaque surface paints a dark line across the bubble — forbidden); once the
// turn's end scrolls into view, the row returns to its natural place right
// under the bubble. The float is GATED on live geometry (see
// syncStickyControls + controlsShouldFloat): raw CSS sticky otherwise
// engages even while the whole turn is still below the fold and the
// containing-block clamp drags the strip to the turn's TOP edge, covering
// the turn's own delete "x" — the strip must never travel above its natural
// slot past the turn's header (see TrailingControls);
// message edits, message deletes, and renames all replace the ENTIRE history
// through the identified PUT, so the next turn automatically sends the
// edited/shortened history to the provider. Every chat is led by a SYSTEM
// prompt turn: a regular LEFT-aligned message row (same wrapper + bubble
// styling as the assistant) that sits at the start of the chat even while
// EMPTY — showing the literal placeholder "no prompt" (clicking the bubble's
// words turns the BUBBLE ITSELF into the contentEditable inline editor,
// saving on blur / cancelling on Escape; no copy action while there is
// nothing to copy). A saved non-empty draft replaces the placeholder text and
// is persisted immediately as the leading system message (creating the chat if
// needed); after that the system turn behaves like any other persisted turn
// (same inline editor, same copy action, same bubble styling, full-history PUT
// rewrites) EXCEPT it cannot be deleted. Assistant (and system) turns span the conversation's FULL
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
// circular ">" arrow docked INSIDE the input box at its RIGHT EDGE, vertically
// CENTERED in the box (top:50% + translateY(-50%)) at every height — one row
// through the eight-row growth cap —
// rendered ONLY while the composer has focus (focus-within via the form's
// onFocus/onBlur: moving between the input, the arrow, and the model select
// keeps it visible; leaving the composer hides it again). The composer input
// starts EXACTLY one text row tall (rows=1 + border-box height math that
// counts the 1px borders, so the first measurement can never inflate the
// box to the browser's two-row textarea default) and auto-grows with newlines
// up to eight rows; its right padding is deepened so text never slides under
// the embedded arrow. The layout needs no narrow-screen shrink defenses:
// the model text and the input stack vertically on every viewport. VOICE INPUT: a
// mic toggle docked at the input's LEFT edge (always visible — unlike the
// focus-gated send arrow, because tapping the input first would just summon the
// on-screen keyboard) fills the SAME input draft with the spoken words through
// the Web Speech API wrapper (src/api/speech.ts): pre-typed words survive
// (the transcript appends one-space separated), the final result stops the
// session AND AUTOMATICALLY SUBMITS the request with the utterance (the
// voiceTranscript gate skips sessions that ended without a single transcript
// frame, so a no-speech ending never fires a send of the stale pre-typed
// draft); an explicit stop X keeps the partial transcript for a manual
// review/send. API-less
// browsers get a non-blocking "not supported" banner instead of a dead button. The
// sidebar is a
// static column on md+ screens and a toggleable drawer below the md breakpoint.
// The message list ALWAYS follows the conversation bottom: typing in the
// composer (the field grows and squeezes the list), the sent message's
// pending bubble, every streamed token of the reply, and every fresh record
// (chat selection, completed turn, edited history) re-pin the list's scroll
// position to its end — the list is the page's only scrolling surface (see
// the viewport-locked Page). TWO carve-outs keep a chosen reading position
// stable: no pin lands while an edge-jump flight owns scrollTop, and pin
// triggers OTHER than composer typing / a send / an explicit chat pick /
// a surface reset re-pin ONLY while the list sits at its bottom edge —
// mid-stream jumps away thus STICK (the old unconditional per-token pin
// yanked the list back down: the "random jumps to the bottom" report);
// the follow silently resumes once the user returns to the bottom.
// Scroll JUMPS are SECTION-LOCAL: every user/assistant/system turn's own
// controls panel (the strip under its bubble) carries an up/down chevron
// pair at its left edge (TurnJumpPair). "^" fast-animates the list until
// THAT section's top edge docks on the list's top padding line; "v" until
// THAT section's bottom edge lands on the bottom padding line — fixed
// 200ms ease-out, distance-independent, re-measured live at arrival in
// case the section reflowed mid-flight (see jumpTurnEdge). Sections never
// share a chevron: each panel scrolls the page's only scrollbar relative
// to its own block. The transient pending/streaming turns render no
// controls panel, so they carry no chevrons.
// ALL control icons in this file come from the shared stroke-based SVG icon
// family in src/icons (menu, close, copy, chevrons) — unicode text
// glyphs were retired because their rendering depended on the system font.
import React, { useCallback, useEffect } from 'react';
import { arrayEach } from '@presource/core';
import { styledComponent, useReferenceHook, useStateHook } from '@presource/react';
// appendTranscript/createSpeechRecognizer/speechRecognitionSupported (api/
// speech.ts) power the composer's voice-to-text toggle: the recognized
// transcript lands in the same input draft the user would have typed.
import {
    addToConversation,
    appendTranscript,
    createConversation,
    createSpeechRecognizer,
    deleteConversation,
    fetchConversation,
    fetchProviderModels,
    listConversations,
    replaceConversationMessages,
    speechContextSecure,
    speechDeniedDetail,
    speechRecognitionSupported,
    streamProviderChatCompletion,
    DEFAULT_CHAT_ASSISTANT_URL,
    DEFAULT_PROVIDER_URL,
    type ChatMessage,
    type ConversationRecord,
    type ConversationSummary,
    type SpeechRecognizerHandle
} from '../api';
// Shared stroke-based SVG icon family (src/icons): every glyph below was
// formerly a unicode text character whose rendering depended on the system
// font — the SVG set draws identically everywhere at any size.
import {
    ChevronDownIcon,
    ChevronRightIcon,
    ChevronUpIcon,
    CloseIcon,
    CopyIcon,
    ForkIcon,
    MenuIcon,
    MicIcon,
    SwitchIcon
} from '../icons';

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
    // Keep vertical spacing stable while tightening only the drawer's mobile
    // horizontal inset so its content does not consume the narrow viewport.
    padding: 16,
    paddingLeft: () => ({ xs: '12px', md: '16px' }),
    paddingRight: () => ({ xs: '12px', md: '16px' }),
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
// `selected` is a visual state prop, not a native button attribute: it gives the
// open conversation an unmistakable active surface while `aria-pressed` below
// preserves the already-established accessible state contract.
const ChatButton = styledComponent<{ selected?: boolean }>('button', {
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 4,
    padding: '12px 32px 12px 12px',
    border: `1px solid ${COLORS.border}`,
    borderRadius: 8,
    backgroundColor: ({ selected }) => (selected ? COLORS.user : COLORS.panelStrong),
    borderColor: ({ selected }) => (selected ? COLORS.accentStrong : COLORS.border),
    color: COLORS.text,
    cursor: 'pointer',
    textAlign: 'left',
    font: 'inherit',
    transition: 'border-color 120ms ease, background-color 120ms ease',
    boxShadow: ({ selected }) => (selected ? `0 0 0 1px ${COLORS.accentStrong}` : 'none')
}) as unknown as React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean }>;

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
    // Mobile content uses 12px horizontal gutters instead of the desktop 24px
    // frame, recovering usable width for bubbles and long assistant replies;
    // static vertical padding keeps scroll-edge calculations unchanged.
    padding: 24,
    paddingLeft: () => ({ xs: '12px', md: '24px' }),
    paddingRight: () => ({ xs: '12px', md: '24px' }),
    // The scroll container remains normally scrollable; mobile scrollbar chrome
    // is suppressed at the render site so the browser cannot reserve a right
    // gutter, while desktop restores its native scrollbar presentation.
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
    // Match MessageList's compact mobile gutters so the empty copy does not
    // receive a second oversized horizontal inset inside the list.
    padding: 24,
    paddingLeft: () => ({ xs: '12px', md: '24px' }),
    paddingRight: () => ({ xs: '12px', md: '24px' }),
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

// Groups the copy icon button so it stays glued to the row's
// right edge — space-between on the parent TurnControls would otherwise spread
// it to the opposite corner.
const TurnActionPair = styledComponent('div', {
    display: 'flex',
    alignItems: 'center',
    gap: 6
});

// Groups the section-local up/down jump chevrons at the row's LEFT edge:
// every turn's scroll affordances live INSIDE the same panel as its copy +
// edit pair (the retired design's single global overlay button could never
// express WHICH section to frame). marginRight:auto is what pushes the
// copy/edit pair to the right edge — the strip itself stays justifyContent:
// flex-end (the pinned-strip cascade a test asserts on the Emotion rule).
const TurnJumpPair = styledComponent('div', {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginRight: 'auto'
});

// The control row EVERY turn renders under its bubble: only the copy + edit
// pair, pushed to the row's right edge.
// STICKY-FOLLOW RULE: position:sticky + bottom:0 turns the row into a
// bottom-pinned strip confined to its OWN turn wrapper. While the turn's
// content extends BEYOND the message list's bottom scrollport edge (the
// turn's end is NOT in view), the row sticks to the list's visible bottom
// edge and rides along with the scroll instead of scrolling away with the
// message tail. The moment the turn's end scrolls INTO view, the sticky
// constraint releases and the row drops back to its natural spot directly
// under the bubble — exactly where it sat before. The containing scrollport
// is MessageList (overflowY:auto — the page's only scrolling surface, see
// Page), and sticky confinement keeps the row inside its own turn's box, so
// it never escapes into a neighbouring message. Turns shorter than the
// viewport (and any turn whose end is already in view) see NO change: the
// row never leaves its natural flow position.
// bottom stays a STATIC number: only 'custom'/function values pass through
// styleStructure's number→rem conversion — statics serialize as px (the same
// trap the Sidebar's static zIndex documents).
// paddingTop cushions the strip ABOVE the buttons: while the strip rides the
// list's bottom edge over the message text scrolling beneath it, the glyphs
// no longer sit flush at the strip's top rim against the passing text — and
// because the strip is bottom-anchored (bottom:0), the padding grows the
// strip UPWARD while the buttons keep their exact pinned position. In the
// natural (unstuck) position the same padding widens the air between the
// bubble and the buttons, so the strip's own geometry never changes between
// its two states. This overrides the '0 4px' shorthand of the TurnControls
// base rule: styledComponent composition serializes the derived rule AFTER
// the base rule in Emotion's sheet, so same-specificity padding-top:8px wins
// (the same cascade the existing justifyContent flex-end-over-space-between
// override already relies on).
// TRANSPARENT BACKGROUND: the strip MUST NOT paint its own surface — an
// opaque strip rendered as a hard dark line slicing horizontally across the
// bubble whenever it rode over message text (the "black line across" bug).
// With no backgroundColor the message content shows straight through around
// the floating glyphs in both states. Sticky positioning always creates a
// stacking context, so even transparent the strip's buttons still paint
// ABOVE the static bubble content they overlap — no z-index needed.
// THE `position` IS A GATED DYNAMIC PROP — NOT a constant sticky: CSS sticky
// alone engages whenever the strip's NATURAL slot sits below the scrollport's
// bottom edge, even while the whole turn is still below the fold; the
// containing-block clamp then drags the strip to the turn's TOP edge, where
// it paints over the turn's own header delete "x" (real-browser geometry
// measured via sticky-probe.mjs). The component measures live rects and only
// renders `floating` (sticky) while the pinned position would clear the
// turn's header row — otherwise the strip renders STATIC, locked to its
// natural slot under the bubble. The two positions serialize as separate
// Emotion classes under @media (min-width: 0px) — the floating one carries
// position:sticky, the anchored one position:static (paddingTop keeps the
// strip's own box identical across the flip so the gate never moves layout).
// The base cast threads the custom `floating` prop through styledComponent's
// generic base-parameter check — the same `as unknown as` composition cast
// ConversationDeleteButton/NewChatButton use on their outputs, applied to the
// input because the prop type lives on the DERIVED component only.
const TrailingControls = styledComponent<{ floating?: boolean }>(TurnControls as unknown as React.FC<{ floating?: boolean }>, {
    justifyContent: 'flex-end',
    position: ({ floating }) => (floating ? 'sticky' : 'static'),
    bottom: 0,
    paddingTop: 8
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

// The attribution label and reversible role control share one horizontal line.
// Keeping the switch outside TurnLabel avoids invalid nested buttons while still
// placing the icon immediately beside the model/speaker name in every expanded
// and collapsed persisted user/assistant turn.
const TurnLabelLine = styledComponent('div', {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    minWidth: 0
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
// The icon is the shared CloseIcon SVG (src/icons); the icon itself is
// aria-hidden, the accessible label lives on the button.
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

// The per-conversation delete control: the SAME CloseIcon treatment as the
// per-message delete, absolutely pinned to the top-right corner of a sidebar
// conversation entry (ChatEntry is its positioning context). It is a SIBLING
// of the select button inside the entry — not nested in it — so clicking the
// x deletes without ever triggering the entry's chat selection.
const ConversationDeleteButton = styledComponent(MessageDeleteButton, {
    position: 'absolute',
    top: 6,
    right: 6
}) as unknown as React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>>;

// Icon-only affordance for the per-message copy action — and for the section
// jump chevrons paired in the same controls row. The icons render from the
// shared stroke-based family (src/icons: CopyIcon/chevrons); the svg is
// aria-hidden, the accessible label lives on the button.
// The `greyed` prop (paired with native disabled at the render site) keeps
// the copy icon RENDERED but dimmed + inert while an inline edit runs
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
// persisted system message or the system prompt is being saved for the first
// time. Both forms render as regular turns with identical chrome (top-left
// "system" label, bubble, click-to-edit inline editor); a non-empty blur commit
// immediately persists the prompt, creating a prompt-only conversation when the
// surface has not sent its first user turn yet. The persisted system turn
// (editable + copyable, never deletable) then takes over.
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
// COLUMN (input full-width, focus-gated send arrow docked at the input's
// right edge, vertically centered in the box — see SendButton);
// align-items:stretch lets the input span the whole row.
const Composer = styledComponent('form', {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    flexShrink: 0,
    gap: 12,
    // The composer follows the message list's compact mobile gutter while
    // retaining the established 16px vertical and desktop spacing.
    padding: 16,
    paddingLeft: () => ({ xs: '12px', md: '16px' }),
    paddingRight: () => ({ xs: '12px', md: '16px' }),
    borderTop: `1px solid ${COLORS.border}`,
    backgroundColor: COLORS.panel
});

// Textarea starts EXACTLY one line high and grows through eight rows as
// newlines add content. The one-row height math is border-aware on purpose:
// box-sizing is border-box (matching the global box-sizing in index.html and
// making jsdom agree), so the visible box must hold the 1.4em line + 24px
// vertical padding + the 2px of vertical borders — shared with
// resizeMessageInput's inline heights, so the ONE-ROW box the vertically
// centered send arrow docks against (and its eight-row growth) never shifts
// its baseline. rows=1 (set at the
// render site) removes the browser's two-row textarea default, which the
// resize effect would otherwise MEASURE as the empty box's scrollHeight and
// lock the field at two rows (the pre-fix bug: a new chat always showed a
// two-row composer). Mouse resizing is disabled so the composer height
// remains controlled by the message content. The composer is a COLUMN now
// (input on top, model text above), so the input spans the full row via
// width:100% — flex:1 would be a flex-basis:0 HEIGHT in a column and collapse
// the field. The HORIZONTAL padding is deepened on BOTH sides so typed text
// never slides under the embedded circles: the send arrow (32px at right:8px)
// and the voice toggle (32px at left:8px, the mirrored left dock). Keyboard
// behavior (see
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
    padding: '12px 52px 12px 52px',
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

// TokenUsage reports the accumulated provider-reported total for the open
// conversation. The server adds each completed turn's usage before returning the
// canonical record; an empty/new record has no usage yet and therefore renders
// zero instead of exposing an ambiguous blank value in the fixed composer chrome.
const TokenUsage = styledComponent('span', {
    position: 'absolute',
    top: 16,
    right: () => ({ xs: '12px', md: '16px' }),
    flexShrink: 0,
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 1.3,
    textAlign: 'right',
    whiteSpace: 'nowrap'
});

// Positioning context for the embedded send arrow: wraps the input.
const ComposerField = styledComponent('div', {
    position: 'relative',
    width: '100%'
});

// The send button: a circular button hosting the right chevron (the authored
// ">" arrow — ChevronRightIcon, not a paper plane) docked INSIDE the input box
// at its RIGHT EDGE, VERTICALLY CENTERED in the box (position:absolute inside
// ComposerField: right:8px + top:50% + translateY(-50%)), rendered ONLY while
// the composer has focus. Centering — instead of the retired bottom:8px pin —
// keeps the circle optically centered in the one-row box AND still centered
// once the textarea auto-grows toward its eight-row cap, where a bottom-
// pinned circle read as stuck to the box's rim (the "not vertically
// centered" report). top/transform stay STRINGS: a bare percentage or
// transform number would risk styleStructure's number→rem conversion (the
// same trap the Sidebar's static zIndex documents). border-radius:50%
// identifies this rule uniquely in Emotion's sheet (asserted by the tests).
const SendButton = styledComponent('button', {
    position: 'absolute',
    right: 8,
    top: '50%',
    transform: 'translateY(-50%)',
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

// Voice input toggle: 32px circular mic docked INSIDE the input box at its
// LEFT edge — the mirrored twin of SendButton's right dock (absolute +
// top:50% + translateY(-50%) inside the ComposerField positioning context).
// ALWAYS rendered, unlike the focus-gated send arrow: talking is a
// first-class input method and requiring a focus tap first would just
// summon the on-screen keyboard on mobile. `listening` flips the surface to
// the danger color (the glyph swap mic→X lives at the render site).
// borderRadius is the STATIC 16 (a 32px square is geometrically circular):
// the static px value keeps the send arrow's `border-radius:50%` the unique
// sheet marker its style rules use for identification.
const VoiceButton = styledComponent<{ listening?: boolean }>('button', {
    position: 'absolute',
    left: 8,
    top: '50%',
    transform: 'translateY(-50%)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
    padding: 0,
    border: 'none',
    borderRadius: 16,
    backgroundColor: ({ listening }) => (listening ? COLORS.danger : COLORS.panelStrong),
    color: ({ listening }) => (listening ? '#ffffff' : COLORS.muted),
    cursor: 'pointer',
    font: 'inherit'
}) as unknown as React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { listening?: boolean }>;

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
    // Keep the error surface aligned with the responsive message/composer
    // gutters instead of leaving a 24px mobile side inset.
    margin: '0 24px 12px',
    marginLeft: () => ({ xs: '12px', md: '24px' }),
    marginRight: () => ({ xs: '12px', md: '24px' }),
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
    // This flag describes whether inline editing is currently allowed. Provider
    // waiting/streaming is deliberately absent: network latency must not make
    // existing controls look disabled or stop the rest of the UI repainting.
    canEdit: boolean;
    // Expanded persisted-turn controls remain visible while a response generates;
    // deletion/prompt persistence still removes their surface because those
    // operations change the record itself.
    showControls: boolean;
    // Turns a bubble INTO the inline HTML editor (contentEditable, focused).
    // The offset is the click's character position (see textOffsetFromPoint):
    // it restores the caret onto the CLICKED WORD after the editable remount;
    // null (the click point could not be resolved, e.g. jsdom) places the
    // caret at the text end.
    onEditStart: (index: number, offset: number | null) => void;
    // Blur-delivered commit: the bubble's DOM text replaces the message via
    // whole-history PUT (see commitEdit in the component for guards).
    onEditCommit: (index: number, text: string) => void;
    // Escape/abandon: close without persisting; the keyed remount reverts the DOM.
    onEditCancel: () => void;
    onMessageDelete: (index: number) => void;
    // Replaces a persisted user role with assistant or assistant with user;
    // the storage PUT rewrites the complete history.
    onMessageRoleSwitch: (index: number) => void;
    // Copies a message's raw text to the system clipboard (client-side only).
    onMessageCopy: (content: string) => void;
    // Creates a new conversation containing this message and its complete
    // persisted prefix, leaving the source conversation unchanged.
    onMessageFork: (index: number) => void;
    // Indices of currently collapsed turns (the fresh-record default seeds
    // this set: everything except the latest assistant reply). Pure
    // session-level UI state.
    collapsedTurns: number[];
    onToggleTurnCollapse: (index: number) => void;
    // Indices of turns whose copy/edit strip is currently in FLOATING mode
    // (pinned to the list's bottom edge by the measured sticky gate — see
    // syncStickyControls). The system prompt draft turn participates as -1.
    stickyTurns: number[];
    // Section-local jump: the strip's up/down chevrons fly the list so THIS
    // turn's top/bottom edge docks on the list's corresponding padding line.
    // The wrapper is addressed by testid (message-turn-N / system-prompt-turn).
    onJumpTurnEdge: (testId: string, toTop: boolean) => void;
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

// Swap only user and assistant roles. Assistant attribution is storage metadata,
// not user-message content, so converting assistant → user drops the old model;
// converting user → assistant records the currently selected model so the new
// assistant turn displays the same producing-model label as streamed replies.
// System prompts are intentionally immutable through this control and are returned
// unchanged as a defensive guard for callers outside the rendered button.
export const switchMessageRole = (message: ChatMessage, assistantModel: string): ChatMessage => {
    if (message.role === 'system') return message;
    if (message.role === 'assistant') return { role: 'user', content: message.content };
    return {
        role: 'assistant',
        content: message.content,
        ...(assistantModel ? { model: assistantModel } : {})
    };
};

// Convert an API record into message nodes while keeping rendering logic
// role-specific and explicit. User and assistant turns are freely editable
// (clicking the expanded bubble's WORDS turns it into the inline editor) and
// individually deletable (x icon in the row ABOVE the bubble, right-aligned);
// both actions rewrite the whole history through the identified PUT. Every
// turn additionally carries a copy action (two-squares icon in the controls
// row under the bubble) that sends the raw message text to the clipboard.
// SYSTEM turns behave exactly like user/assistant turns (same inline editor,
// same copy action) EXCEPT they never render the delete cross — the system
// prompt cannot be removed (a chat without one shows the empty draft turn at
// the top of the list instead, not a system turn).
// Every turn's row ABOVE its bubble carries an ATTRIBUTION LABEL on the LEFT:
// the producing model's stripped name for assistant turns with a recorded
// ChatMessage.model (older records without it fall back to "assistant"),
// otherwise the literal speaker label ("user" / "system" for now). That label
// IS the collapse toggle — no chevron glyph ever renders. Collapsed turns hide
// the bubble AND its copy/delete controls, showing the label plus a
// one-line first-line preview instead; clicking the preview expands the turn.
// While ANY turn is being edited NO chrome disappears: every turn's header row
// (the model/speaker label) stays rendered — its collapse toggle merely greys
// out + disables on the EDITED turn so folding cannot unmount the live editor —
// and every turn's copy/delete icons stay rendered but greyed out +
// natively disabled (one edit at a time). Conversation deletion and prompt
// persistence (showControls === false) still hide the icons; provider streaming
// does not.
const renderMessages = (messages: ChatMessage[], options: MessageListOptions): React.ReactNode[] => {
    const nodes: React.ReactNode[] = [];
    arrayEach(messages, ({ index, value: message }) => {
        const key = `${message.role}-${index}`;
        const editing = options.editingIndex === index;
        const collapsed = options.collapsedTurns.includes(index);
        // The copy action (controls row under the bubble) and the delete cross
        // appear on every EXPANDED turn unless the conversation is being deleted
        // or its prompt is being persisted. Generation never contributes to this
        // visual state: waiting for a provider must not grey out the dashboard.
        // Collapsed turns still hide their bubble row by design. Only an active
        // inline edit greys controls, preserving the one-editor-at-a-time rule.
        const controlsGreyed = options.editingIndex !== null;
        const controlsVisible = !collapsed && options.showControls;
        // The delete cross sits on the RIGHT of the header row above the bubble;
        // SYSTEM messages are the one non-deletable turn: edit + copy still apply.
        const deleteControl = controlsVisible && message.role !== 'system' ? (
            <MessageDeleteButton
                type="button"
                greyed={controlsGreyed}
                disabled={controlsGreyed}
                onClick={() => options.onMessageDelete(index)}
                aria-label="Delete message"
                title="Delete message"
                data-testid={`delete-message-${index}`}
            >
                <CloseIcon size={14} />
            </MessageDeleteButton>
        ) : null;
        // Copying writes ANY message's raw text to the clipboard and never
        // touches storage. Visibility matches the delete cross's row rule
        // (idle, expanded). The icon is the
        // shared CopyIcon (two overlapping squares — the "clone" glyph of the
        // turn chrome).
        const copyControl = controlsVisible ? (
            <TurnIconButton
                type="button"
                greyed={controlsGreyed}
                disabled={controlsGreyed}
                onClick={() => options.onMessageCopy(message.content)}
                aria-label="Copy message"
                title="Copy message"
                data-testid={`copy-message-${index}`}
            >
                <CopyIcon size={14} />
            </TurnIconButton>
        ) : null;
        // Forking is available beside copy for every EXPANDED persisted
        // user/assistant interval. Collapsed turns intentionally hide all
        // bubble controls, including fork, until their content is expanded.
        const forkControl = controlsVisible && message.role !== 'system' ? (
            <TurnIconButton
                type="button"
                greyed={controlsGreyed}
                disabled={controlsGreyed}
                onClick={() => options.onMessageFork(index)}
                aria-label="Fork conversation from this message"
                title="Fork conversation from this message"
                data-testid={`fork-message-${index}`}
            >
                <ForkIcon size={14} />
            </TurnIconButton>
        ) : null;
        // The role switch remains beside the attribution label even while a turn
        // is collapsed, because the label is the visible handle in that state.
        // During another inline edit it stays rendered but disabled/greyed, while
        // deletion or prompt persistence removes it with the changing record.
        const roleSwitchControl = options.showControls && message.role !== 'system' ? (
            <TurnIconButton
                type="button"
                greyed={controlsGreyed}
                disabled={controlsGreyed}
                onClick={() => options.onMessageRoleSwitch(index)}
                aria-label={`Switch ${message.role} message to ${message.role === 'user' ? 'assistant' : 'user'}`}
                title={`Switch ${message.role} message to ${message.role === 'user' ? 'assistant' : 'user'}`}
                data-testid={`switch-message-${index}`}
            >
                <SwitchIcon size={14} />
            </TurnIconButton>
        ) : null;
        // Smart inline editing: clicking the expanded bubble's WORDS turns the
        // bubble ITSELF into the editor (contentEditable — no textarea, no
        // separate input field), restoring the caret onto the CLICKED WORD via
        // the captured click-point offset. The guard requires an idle,
        // expanded turn with no other edit running, so clicking is inert while
        // streaming, deleting, or editing another turn. The handler is
        // undefined (not merely blocking) while unavailable so the cursor hint
        // and the click affordance agree.
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
                    <TurnLabelLine>
                        {/* User turns are right-aligned, so placing the switch
                            before the label keeps the icon on the label's LEFT;
                            assistant turns place it after the model name below. */}
                        {alignRight && roleSwitchControl}
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
                        {!alignRight && roleSwitchControl}
                    </TurnLabelLine>
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
            // The controls row renders while the turn is expanded, including
            // while a response streams or another turn is edited. Only the
            // active-edit state intentionally greys its mutation controls.
            nodes.push(
                <UserTurn key={key} collapsed={collapsed} data-testid={`message-turn-${index}`}>
                    {headerRow}
                    {bubble}
                    {copyControl !== null && (
                        // floating = measured sticky gate (component state);
                        // the testid is the gate's per-turn measurement hook.
                        // Section-local scroll chevrons sit INSIDE the same
                        // panel as the copy action (left edge; the action
                        // stays glued right): "^" flies the list so THIS
                        // turn's top edge docks on the list's top padding
                        // line, "v" so its bottom edge lands on the bottom
                        // padding line (see jumpTurnEdge).
                        <TrailingControls floating={options.stickyTurns.includes(index)} data-testid={`turn-controls-${index}`}>
                            <TurnJumpPair>
                                 <TurnIconButton type="button" greyed={controlsGreyed} disabled={controlsGreyed} onClick={() => options.onJumpTurnEdge(`message-turn-${index}`, true)} aria-label="Scroll to section top" title="Scroll to section top" data-testid={`turn-jump-top-${index}`}><ChevronUpIcon size={14} /></TurnIconButton>
                                 <TurnIconButton type="button" greyed={controlsGreyed} disabled={controlsGreyed} onClick={() => options.onJumpTurnEdge(`message-turn-${index}`, false)} aria-label="Scroll to section bottom" title="Scroll to section bottom" data-testid={`turn-jump-bottom-${index}`}><ChevronDownIcon size={14} /></TurnIconButton>
                            </TurnJumpPair>
                            <TurnActionPair>
                                {copyControl}
                                {forkControl}
                            </TurnActionPair>
                        </TrailingControls>
                    )}
                </UserTurn>
            );
        } else if (message.role === 'assistant') {
            // The producing model marks the turn in its top-left header label
            // (see headerRow above, replacing the old caption under the bubble);
            // the row below carries only the shared copy action, exactly
            // like the other roles.
            nodes.push(
                <AssistantTurn key={key} collapsed={collapsed} data-testid={`message-turn-${index}`}>
                    {headerRow}
                    {bubble}
                    {copyControl !== null && (
                        // floating = measured sticky gate (component state);
                        // the testid is the gate's per-turn measurement hook.
                        // Section-local scroll chevrons sit INSIDE the same
                        // panel as the copy action (left edge; the action
                        // stays glued right): "^" flies the list so THIS
                        // turn's top edge docks on the list's top padding
                        // line, "v" so its bottom edge lands on the bottom
                        // padding line (see jumpTurnEdge).
                        <TrailingControls floating={options.stickyTurns.includes(index)} data-testid={`turn-controls-${index}`}>
                            <TurnJumpPair>
                                 <TurnIconButton type="button" greyed={controlsGreyed} disabled={controlsGreyed} onClick={() => options.onJumpTurnEdge(`message-turn-${index}`, true)} aria-label="Scroll to section top" title="Scroll to section top" data-testid={`turn-jump-top-${index}`}><ChevronUpIcon size={14} /></TurnIconButton>
                                 <TurnIconButton type="button" greyed={controlsGreyed} disabled={controlsGreyed} onClick={() => options.onJumpTurnEdge(`message-turn-${index}`, false)} aria-label="Scroll to section bottom" title="Scroll to section bottom" data-testid={`turn-jump-bottom-${index}`}><ChevronDownIcon size={14} /></TurnIconButton>
                            </TurnJumpPair>
                            <TurnActionPair>
                                {copyControl}
                                {forkControl}
                            </TurnActionPair>
                        </TrailingControls>
                    )}
                </AssistantTurn>
            );
        } else {
            // System turn: same click-to-edit bubble + copy action as every
            // other turn, but NO delete cross — the system prompt cannot be
            // removed. It starts collapsed by default (the component seeds
            // collapsedTurns with the record's default collapsed indices —
            // every turn except the latest assistant reply — whenever a fresh
            // record loads).
            nodes.push(
                <SystemTurn key={key} collapsed={collapsed} data-testid={`message-turn-${index}`}>
                    {headerRow}
                    {bubble}
                    {copyControl !== null && (
                        // floating = measured sticky gate (component state);
                        // the testid is the gate's per-turn measurement hook.
                        // Section-local scroll chevrons sit INSIDE the same
                        // panel as the copy action (left edge; the action
                        // stays glued right): "^" flies the list so THIS
                        // turn's top edge docks on the list's top padding
                        // line, "v" so its bottom edge lands on the bottom
                        // padding line (see jumpTurnEdge).
                        <TrailingControls floating={options.stickyTurns.includes(index)} data-testid={`turn-controls-${index}`}>
                            <TurnJumpPair>
                                 <TurnIconButton type="button" greyed={controlsGreyed} disabled={controlsGreyed} onClick={() => options.onJumpTurnEdge(`message-turn-${index}`, true)} aria-label="Scroll to section top" title="Scroll to section top" data-testid={`turn-jump-top-${index}`}><ChevronUpIcon size={14} /></TurnIconButton>
                                 <TurnIconButton type="button" greyed={controlsGreyed} disabled={controlsGreyed} onClick={() => options.onJumpTurnEdge(`message-turn-${index}`, false)} aria-label="Scroll to section bottom" title="Scroll to section bottom" data-testid={`turn-jump-bottom-${index}`}><ChevronDownIcon size={14} /></TurnIconButton>
                            </TurnJumpPair>
                            <TurnActionPair>
                                {copyControl}
                                {forkControl}
                            </TurnActionPair>
                        </TrailingControls>
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

// Half-pixel sacrifice to sub-pixel scroll geometry: list/turn rects arrive
// with fractional coordinates (browser zoom, devicePixelRatio), so boundary
// equality must not flicker the floating mode on and off across a 0.5px line.
const CONTROLS_FLOAT_EPSILON = 0.5;

// Edge tolerance for the bottom-follow gate's edge detection: scrollTop +
// clientHeight within 1px of scrollHeight already counts as "at the bottom"
// (fractional scroll geometry and browser clamping must not detach the
// token follow while the user is one subpixel above the edge).
const LIST_EDGE_EPSILON = 1;

// Fixed animation budget (ms) for the edge jump. "Fast" per the control's
// contract: a FIXED duration rather than distance-proportional scrolling, so
// a 500-turn chat reaches its far edge exactly as quickly as a 5-turn one.
const JUMP_SCROLL_DURATION = 200;

// Pure sticky-gate predicate for a turn's copy/edit strip — the anti-"black
// line across the x" rule. The strip may FLOAT (position:sticky, pinned to
// the list's visible bottom edge) only while BOTH hold:
// - its turn's END is NOT in view: the natural strip slot (flush with the
//   turn's bottom — the strip is the turn's last child) lies strictly below
//   the pin line (the list's bottom inner edge);
// - and the PINNED position would NOT collide with the turn's own header row
//   (the attribution label + delete "x" area): the pin top (pin line minus
//   the strip's measured height) stays at or below the header row's bottom.
//   Without this second clause raw CSS sticky also engages while the whole
//   turn is BELOW the fold, and the containing-block clamp drags the strip
//   onto the turn's TOP edge, covering the "x" (geometry verified in real
//   Chrome via sticky-probe.mjs: turn [520,1324], x [520,542], raw strip
//   clamped to [520,550] — full overlap). With the gate the strip holds its
//   natural (invisible, below-fold) slot until scrolling reveals enough turn
//   that the float clears the header.
// Exported for the boundary unit tests in ChatAssistantApp.test.tsx.
export const controlsShouldFloat = (turnBottom: number, headerBottom: number, pinBottom: number, stripHeight: number): boolean =>
    turnBottom - pinBottom > CONTROLS_FLOAT_EPSILON && pinBottom - stripHeight >= headerBottom - CONTROLS_FLOAT_EPSILON;

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
    // Local text for the system prompt editor, shown ONLY while the selected
    // record lacks a leading system message. While EMPTY the turn's bubble
    // shows the literal placeholder "no prompt"; a non-empty blur commit is
    // persisted immediately by saveSystemPromptDraft.
    // Cleared on new chat, on chat switch, on conversation deletion, and
    // after a completed send.
    const systemPrompt = useStateHook('');
    // The draft turn's own inline editing flag (opened by clicking its
    // bubble's words): there is NO textarea state — the bubble IS the editor
    // (contentEditable), its text lives in the DOM until blur commits the
    // trimmed text into `systemPrompt` or Escape cancels (the keyed remount
    // reverts the DOM to the saved draft).
    const editingSystemPrompt = useStateHook(false);
    // Guards the asynchronous prompt PUT/create flow so a second edit or send
    // cannot race the first persistence request and overwrite its history.
    const savingSystemPrompt = useStateHook(false);
    // Indices of currently collapsed message turns. Seeded via
    // defaultCollapsedIndices (ALL turns except the latest assistant reply:
    // user turns fold, system turns fold, older replies fold) whenever a fresh
    // record loads or replaces the history; resetting accompanies new chat /
    // chat switch / deletion. Session-level UI state, never persisted.
    const collapsedTurns = useStateHook<number[]>([]);
    // Indices of turns whose copy/edit strip currently FLOATS (pinned to the
    // message list's visible bottom edge). Measured live by syncStickyControls
    // (scroll/resize listeners + a post-commit geometry effect below); -1 is
    // the system prompt draft turn's sentinel index. Starts empty = every
    // strip anchored at its natural slot under its bubble.
    const stickyTurns = useStateHook<number[]>([]);
    // Bottom-edge truth, measured in the SAME sync pass as the strips
    // (syncStickyControls): listAtBottom gates the bottom-follow effect
    // (ambient refreshes re-pin ONLY while the list sits at its bottom
    // edge — see the follow effect). An empty/unloaded list counts as "at
    // bottom" so a fresh chat's first content pins.
    const listAtBottom = useStateHook(true);
    // Ref-backed (write-without-render) rAF handle of an in-flight edge jump:
    // a fresh click cancels the running flight before retargeting, and the
    // unmount cleanup below cancels a pending frame so it never writes to a
    // detached list. Also read by the bottom-follow effect below: while a
    // flight owns scrollTop, NOTHING else may write it. The handle's function
    // identity is STABLE across renders by @presource/react contract
    // (reference.ts creates the accessor once per component lifetime) — the
    // [listJump] deps below depend on that stability (see the cleanup effect).
    const listJump = useReferenceHook<number | null>(null);
    // Ref snapshot of the bottom-follow effect's OWN dep tuple from the
    // previous run, used to classify WHICH trigger family a commit belongs
    // to (typing / send / explicit navigation / ambient refresh — see the
    // effect). Ref-backed so bookkeeping never re-renders.
    const followSnapshot = useReferenceHook<{
        draft: string;
        pending: string;
        stream: string;
        record: ConversationRecord | null;
    } | null>(null);
    // One-shot mark set by selectChat: the NEXT bottom-follow run is an
    // explicit chat pick, which always pins — opened chats land on their
    // latest turn regardless of the surface's previous scroll position
    // (the at-bottom state read at that moment still describes the chat
    // being LEFT). Consumed (cleared) by the effect's first following run.
    const selectionPin = useReferenceHook(false);
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
    // remount — then clears it so a later unresolvable click point falls back
    // to the text end. See textOffsetFromPoint / placeCaretAtOffset.
    const caretOffset = useReferenceHook<number | null>(null);
    // Voice input (src/api/speech.ts): `listening` drives the mic→X glyph and
    // the danger surface; `recognizer` holds the live session handle (a ref
    // write, no re-render — the handle is created at session start); the
    // draft snapshot taken at start is the transcript's append base.
    const listening = useStateHook(false);
    const recognizer = useReferenceHook<SpeechRecognizerHandle | null>(null);
    const speechDraft = useReferenceHook<string>('');
    // Voice auto-send gate: the FIRST recognition frame of a session (interim
    // or final — src/api/speech.ts always delivers the final settled text
    // before settle() fires onEnd) flips it true, and the finished-utterance
    // auto-send at session end reads it. A session that ends WITHOUT any
    // frame (a no-speech silence, an early permission error before the
    // engine hears anything) must NOT submit the pre-typed draft that may
    // already sit in the input. Reset on every session start (toggle-on path
    // in startListening below). Ref-backed: it only flips false→true once
    // per session, so writes never re-render on purpose.
    const voiceTranscript = useReferenceHook(false);

    // Unmount cleanup: discard a still-live voice session so the speech
    // engine keeps delivering nothing to a dead component. dispose() detaches
    // the engine's callbacks and settles silently (src/api/speech.ts); the
    // ref accessor's handle identity is stable for the component lifetime
    // (@presource/react reference contract, see the listJump effect note).
    useEffect(() => () => {
        recognizer()?.dispose();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

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
    // TWO carve-outs keep a USER-CHOSEN reading position stable against this
    // force-pin (the reported "^ never reaches the top / random jumps to the
    // bottom" glitches — the unconditional pin used to win every race):
    // 1. IN-FLIGHT JUMP: while an edge-jump flight owns scrollTop (listJump
    //    holds its rAF handle) NOTHING else may write it — a mid-flight pin
    //    would fight the rAF's per-frame positions.
    // 2. OFF-BOTTOM AMBIENT REFRESHES: trigger families OTHER than an
    //    explicit user signal re-pin ONLY while the list sits at its bottom
    //    edge (listAtBottom, refreshed by syncStickyControls' scroll pass).
    //    Ambient families: streamed tokens AND same-surface record refreshes
    //    (the completion swap after a streamed turn, edit/delete rewrites,
    //    the first turn's null→record load). A mid-stream section jump (or
    //    plain wheel-scroll away) therefore STICKS — no more yank-to-bottom
    //    at the next token or at stream completion; the follow silently
    //    resumes once the user returns to the bottom.
    // EXPLICIT signals keep the ORIGINAL unconditional pin (classified
    // against followSnapshot): composer TYPING (draft changed), a SEND
    // (pending bubble appeared), an explicit CHAT PICK (selectChat's
    // one-shot selectionPin mark — the opened chat lands on its latest turn
    // even when the surface being left was scrolled up), and a surface
    // RESET (record cleared by new-chat/delete).
    // The snapshot rewrites on EVERY run — skipped pins included — so the
    // classification never goes stale (StrictMode's double-run reads an
    // identical tuple: an idempotent pin). scrollTop/scrollHeight are plain
    // settable properties everywhere (jsdom included: scrollHeight is 0
    // there, so tests stub it).
    useEffect(() => {
        const list = document.querySelector<HTMLElement>('[data-testid="message-list"]');
        const current = { draft: message(), pending: pendingUser(), stream: streaming(), record: selected() };
        const explicitSelection = selectionPin();
        if (explicitSelection) selectionPin(false);
        const previous = followSnapshot();
        followSnapshot(current);
        const typed = previous !== null && previous.draft !== current.draft;
        const sent = previous !== null && previous.pending === '' && current.pending !== '';
        const surfaceReset = previous !== null && previous.record !== current.record && current.record === null;
        if (list && listJump() === null && (previous === null || explicitSelection || typed || sent || surfaceReset || listAtBottom())) {
            list.scrollTop = list.scrollHeight;
        }
        // Deps read accessor state: draft text, pending bubble, stream, record.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [message(), pendingUser(), streaming(), selected()]);

    // Sticky-gate measurement: decide PER TURN whether its copy/edit strip
    // may float (position:sticky) or must stay anchored (position:static) —
    // the rule itself is the exported pure predicate controlsShouldFloat.
    // The same pass refreshes the bottom-follow gate's edge truth
    // (listAtBottom). Both writes are guarded by equality so this
    // scroll-position listener can never re-render itself into a loop.
    // Measured inputs: the pin line is the list's bottom PADDING edge (sticky
    // offsets resolve against the scrollport's padding box — a measured
    // pinned strip sits flush against it, hence the padding subtraction);
    // the strip's natural slot is known from the TURN's bottom edge alone
    // (the strip is always the turn's last child, flush: turn bottom ==
    // natural strip bottom), so the verdict never reads the strip's own LIVE
    // rect — which would be the pinned rect while floating and could
    // oscillate the gate. Sticky positioning preserves the strip's flow
    // space, so flipping the mode changes none of the measured inputs: no
    // feedback loop. The delete "x" needs no own measurement: it lives in
    // the turn's FIRST child (TurnHeaderRow), whose bottom edge is the gate
    // boundary. jsdom rects are all 0: turnBottom(0) - pinBottom(0) is never
    // > epsilon, so every strip deterministically stays anchored there.
    const syncStickyControls = useCallback(() => {
        const list = document.querySelector<HTMLElement>('[data-testid="message-list"]');
        if (!list) return;
        // Bottom-follow gate geometry: read BEFORE anything else touches
        // scrollTop. The epsilon means fractional geometry and the browser's
        // scroll clamping (scrollTop can never exceed scrollHeight -
        // clientHeight) cannot detach the token follow one subpixel early.
        const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - LIST_EDGE_EPSILON;
        if (atBottom !== listAtBottom()) listAtBottom(atBottom);
        const listRect = list.getBoundingClientRect();
        const pinBottom = listRect.bottom - (Number.parseFloat(window.getComputedStyle(list).paddingBottom) || 0);
        const next: number[] = [];
        list.querySelectorAll<HTMLElement>('[data-testid^="turn-controls-"], [data-testid="system-prompt-controls"]').forEach((controls) => {
            const turn = controls.closest<HTMLElement>('[data-testid^="message-turn-"], [data-testid="system-prompt-turn"]');
            // The turn's header row (attribution label + delete "x") is always
            // its FIRST rendered child, so no testid is needed for it.
            const header = turn?.firstElementChild as HTMLElement | null;
            if (!turn || !header) return;
            const floats = controlsShouldFloat(
                turn.getBoundingClientRect().bottom,
                header.getBoundingClientRect().bottom,
                pinBottom,
                controls.getBoundingClientRect().height
            );
            if (floats) {
                // Turn key comes from the strip's testid (turn-controls-N for
                // message turns; system-prompt-controls → the -1 sentinel).
                const testId = controls.getAttribute('data-testid') ?? '';
                next.push(testId === 'system-prompt-controls' ? -1 : Number(testId.slice('turn-controls-'.length)));
            }
        });
        // Sorted join compare: identical membership writes nothing, so the
        // gate can never re-render itself into a loop.
        next.sort((a, b) => a - b);
        if (next.join(',') !== stickyTurns().join(',')) stickyTurns(next);
    }, [listAtBottom, stickyTurns]);

    // Scroll + resize drive the gate: mount-only listener attach (the message
    // list element is permanent — it renders on every surface, empty chats
    // included). Passive: the handler only reads geometry and flips state.
    useEffect(() => {
        const list = document.querySelector<HTMLElement>('[data-testid="message-list"]');
        list?.addEventListener('scroll', syncStickyControls, { passive: true });
        window.addEventListener('resize', syncStickyControls);
        return () => {
            list?.removeEventListener('scroll', syncStickyControls);
            window.removeEventListener('resize', syncStickyControls);
        };
    }, [syncStickyControls]);

    // Geometry also changes WITHOUT a scroll event: collapse toggles shift
    // turn heights, streamed tokens grow the live bubble, record loads swap
    // the whole list, and ingress/egress of the pending turns re-flows the
    // bottom. Re-measure after every commit touching that dep family (the
    // same family the scroll-pin effect above tracks, plus the collapse set
    // plus loading/deleting, which mount/unmount the strips themselves). The
    // auto-pin's own scroll event also re-triggers the listener above, so
    // post-pin geometry converges through it.
    useEffect(() => {
        syncStickyControls();
        // Deps read accessor state; syncStickyControls is a stable useCallback.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [message(), pendingUser(), streaming(), selected(), collapsedTurns(), loading(), deleting(), syncStickyControls]);

    // A turn chevron's click action: the up/down chevrons live INSIDE each
    // section's own copy/edit panel (the retired design's ONE global overlay
    // chevron could never express WHICH section to frame), so each flight is
    // resolved AGAINST THE CLICKED SECTION's wrapper (looked up by testid):
    // toTop docks the section's TOP edge on the message list's top padding
    // line, otherwise its BOTTOM edge lands on the bottom padding line.
    // Rects are viewport-live: edge − list's rect top + current scrollTop
    // converts to scroll-content coordinates; the list's own padding
    // re-centres the edge ON the padding line (a docked section sits exactly
    // where normal flow content starts); targets clamp to the real travel
    // range. The animation is the shared fixed JUMP_SCROLL_DURATION ease-out
    // cubic (fast launch, soft landing) driven by rAF: FAST per requirement
    // and distance-INDEPENDENT — a tall section never crawls proportionally.
    // Frames write scrollTop directly. ARRIVAL re-measures the target LIVE:
    // an inlined editor or a reflowing neighbour can move a section's far
    // edge DURING the 200ms flight, so a compute-once target would land
    // short of the real edge. syncStickyControls then runs so the sticky
    // strips settle even in environments that do not dispatch scroll events
    // for programmatic scrollTop writes (jsdom).
    // Environments without rAF (and zero-travel clicks) jump INSTANTLY.
    const jumpTurnEdge = useCallback((testId: string, toTop: boolean) => {
        const list = document.querySelector<HTMLElement>('[data-testid="message-list"]');
        const turn = list?.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
        if (!list || !turn) return;
        // A fresh click cancels the in-flight flight before retargeting.
        if (listJump() !== null) cancelAnimationFrame(listJump()!);
        // Section-edge measurement (see the block comment).
        const measureTarget = (): number => {
            const listTop = list.getBoundingClientRect().top;
            const maxScroll = Math.max(0, list.scrollHeight - list.clientHeight);
            if (toTop) {
                const paddingTop = Number.parseFloat(window.getComputedStyle(list).paddingTop) || 0;
                return Math.min(maxScroll, Math.max(0, list.scrollTop + turn.getBoundingClientRect().top - listTop - paddingTop));
            }
            const paddingBottom = Number.parseFloat(window.getComputedStyle(list).paddingBottom) || 0;
            return Math.min(maxScroll, Math.max(0, list.scrollTop + turn.getBoundingClientRect().bottom - listTop + paddingBottom - list.clientHeight));
        };
        const startTop = list.scrollTop;
        const targetTop = measureTarget();
        if (targetTop === startTop || typeof requestAnimationFrame !== 'function') {
            list.scrollTop = targetTop;
            listJump(null);
            syncStickyControls();
            return;
        }
        const distance = targetTop - startTop;
        // Clock discipline: the flight is measured on the rAF timeline ALONE
        // — the first frame's own timestamp is the t0. Mixing clocks here
        // (performance.now() vs the rAF callback's `now`) breaks the easing
        // catastrophically wherever the two epochs differ (jsdom's rAF clock
        // starts near 0 while Node's performance clock is deep into the
        // process lifetime: progress went hugely negative, the cubic eased
        // past -98× the distance, and the list "jumped" to scrollTop -78900).
        // The [0, 1] clamp on BOTH ends is the second belt: an early/late
        // frame can never overshoot the edge.
        let startTime: number | undefined;
        const step = (now: number) => {
            if (startTime === undefined) startTime = now;
            const progress = Math.min(Math.max((now - startTime) / JUMP_SCROLL_DURATION, 0), 1);
            // Ease-out cubic: 1 - (1 - p)^3.
            list.scrollTop = startTop + distance * (1 - Math.pow(1 - progress, 3));
            if (progress < 1) {
                listJump(requestAnimationFrame(step));
            } else {
                // Re-measured LIVE edge (see above): mid-flight reflows can
                // never strand the landing short of the section's edge.
                list.scrollTop = measureTarget();
                listJump(null);
                syncStickyControls();
            }
        };
        listJump(requestAnimationFrame(step));
    }, [listJump, syncStickyControls]);

    // Never let a pending jump frame write to a detached list on unmount.
    // The [listJump] dep MUST hold a stable identity across renders or this
    // cleanup re-runs on EVERY re-render and cancels the flight mid-animation:
    // that was the "^ goes partially, second click completes" glitch — the
    // up-click's first frame detached listAtBottom, the scroll event's
    // syncStickyControls flipped it (a state update → re-render), the fresh
    // listJump identity re-fired this effect, and the cleanup killed the rAF
    // at ~25% of the distance. useReferenceHook now guarantees a create-once
    // accessor (packages/presource/react/src/hooks/local/reference.ts), so
    // this effect mounts/unmounts only.
    useEffect(() => () => {
        if (listJump() !== null) cancelAnimationFrame(listJump()!);
    }, [listJump]);

    // Focus the surface that just became the inline HTML editor (a message
    // bubble, the system prompt draft bubble, or the header title). The node
    // remounts keyed on entering edit mode, so the effect (not a ref callback)
    // focuses the fresh node — no ref-identity churn can steal the caret back
    // on unrelated re-renders. The caret is then RESTORED to the click's
    // captured character offset (without it, programmatic focus dumps the
    // caret at the text start); null offset (unresolvable click point, e.g.
    // jsdom without caretRangeFromPoint) lands at the text end.
    // preventScroll is LOAD-BEARING — the long-chat scroll-jump fix: default
    // focus() SCROLLS every scrollable ancestor to reveal the focused node,
    // and for a contentEditable the browser additionally plants a provisional
    // caret at offset 0 and scrolls THAT into view. With a long chat the
    // clicked bubble's top edge (the offset-0 spot) sits above the list's
    // scrollport, so the list snapped UP to the message's top — and because
    // placeCaretAtOffset's programmatic addRange never scrolls back, the-view
    // stayed jumped while the caret sat at the clicked word: the reported
    // disorientation. preventScroll:true skips the scroll step entirely (HTML
    // focus processing model); the clicked word is on screen by definition,
    // so nothing ever needs revealing. End-placed carets (unresolvable click
    // point) stay equally calm — if the end is below the fold, the browser's
    // native caret reveal engages on the first typed character instead.
    // Browsers too old for FocusOptions ignore the argument harmlessly.
    useEffect(() => {
        if (editingIndex() !== null || editingSystemPrompt() || editingTitle()) {
            const target = document.querySelector<HTMLElement>('[data-editing="true"]');
            if (target) {
                target.focus({ preventScroll: true });
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
    // Provider waiting/streaming does not block title editing; only deletion
    // blocks a rename because the selected surface is being removed.
    const startTitleEdit = useCallback((offset: number | null = null) => {
        if (deleting()) return;
        caretOffset(offset);
        editingTitle(true);
    }, [caretOffset, deleting, editingTitle]);

    // Stop editing the system prompt draft (Escape, chat switching, new chat,
    // deletion, completed send). The saved text (systemPrompt) is NOT touched
    // here — the keyed bubble remount reverts any half-typed DOM text.
    const cancelSystemPromptDraft = useCallback(() => {
        editingSystemPrompt(false);
    }, [editingSystemPrompt]);

    // Turn the draft prompt's bubble into the inline editor (a click on its
    // words is the trigger). The bubble renders the saved draft's text; editing
    // happens in the DOM until blur commits. The offset restores the caret to
    // the clicked word (null → text end, the unresolvable-point fallback).
    const startSystemPromptEdit = useCallback((offset: number | null = null) => {
        caretOffset(offset);
        editingSystemPrompt(true);
    }, [caretOffset, editingSystemPrompt]);

    // Commit the draft bubble's BLUR-delivered text. A blank commit only clears
    // the local editor. A non-empty commit immediately persists a leading system
    // message: an existing chat uses whole-history PUT, while a new surface is
    // created through POST with systemPrompt. The surface/text guards prevent a
    // late response from resurrecting a chat after navigation during the save.
    const saveSystemPromptDraft = useCallback(async (rawText: string) => {
        if (!editingSystemPrompt()) return;
        const text = rawText.trim();
        const record = selected();
        const originalConversationId = record?.conversationId ?? null;
        editingSystemPrompt(false);
        systemPrompt(text);
        if (!text || savingSystemPrompt() || deleting()) return;

        savingSystemPrompt(true);
        try {
            let result: ConversationRecord;
            if (record) {
                // The draft UI only renders when the record has no system turn,
                // so prepend the newly saved prompt without disturbing history.
                result = (await replaceConversationMessages(baseUrl, record.conversationId, {
                    messages: [{ role: 'system', content: text }, ...record.messages]
                })).conversation;
            } else {
                // A new-chat prompt must have a server record of its own; otherwise
                // leaving the page before the first user send loses the edit.
                const request = model() ? { model: model(), systemPrompt: text } : { systemPrompt: text };
                const conversationId = (await createConversation(baseUrl, request)).conversationId;
                result = (await fetchConversation(baseUrl, conversationId)).conversation;
            }

            // The prompt response may arrive after New chat or another chat pick.
            // Apply it only when the original surface still owns this draft text;
            // the sidebar summary is updated regardless so the server write remains
            // discoverable after the user navigates away.
            const sameSurface = (selected()?.conversationId ?? null) === originalConversationId
                && systemPrompt().trim() === text;
            if (sameSurface) {
                selected(result);
                systemPrompt('');
                collapsedTurns(defaultCollapsedIndices(result.messages));
                cancelSystemPromptDraft();
            }
            const summary = summaryFromRecord(result);
            const current = chats();
            chats(current.some((chat) => chat.conversationId === summary.conversationId)
                ? current.map((chat) => chat.conversationId === summary.conversationId ? summary : chat)
                : [summary, ...current]);
            error('');
        } catch (reason) {
            // Keep the typed prompt visible for retry when persistence fails, but
            // never overwrite a different surface's state after navigation.
            if ((selected()?.conversationId ?? null) === originalConversationId) systemPrompt(text);
            error(reason instanceof Error ? reason.message : String(reason));
        } finally {
            savingSystemPrompt(false);
        }
    }, [baseUrl, cancelSystemPromptDraft, chats, collapsedTurns, deleting, editingSystemPrompt, error, model, savingSystemPrompt, selected, systemPrompt]);

    // Select a conversation and fetch its full message history; the recorded model
    // applies only when nothing is remembered (a remembered/picked model wins).
    const selectChat = useCallback(async (conversationId: string) => {
        loading(true);
        try {
            const record = (await fetchConversation(baseUrl, conversationId)).conversation;
            // Explicit navigation: the bottom-follow effect consumes this
            // one-shot mark and pins the freshly opened chat to its latest
            // turn unconditionally (ambient record refreshes can't do that).
            selectionPin(true);
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
    }, [applyModelMemory, baseUrl, cancelEdit, cancelSystemPromptDraft, cancelTitleEdit, collapsedTurns, error, loading, selected, selectionPin, sidebarOpen, systemPrompt]);

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
    // turn is streaming; the active request still owns its original record and
    // completion state is reconciled by the send flow.
    const deleteChat = useCallback(async (conversationId: string) => {
        if (deleting()) return;
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
    }, [baseUrl, cancelEdit, cancelSystemPromptDraft, cancelTitleEdit, chats, collapsedTurns, deleting, error, message, selected, systemPrompt]);

    // Turn one message's bubble into the inline HTML editor (contentEditable,
    // auto-focused by the editing effect above). The offset restores the caret
    // to the clicked word; null (unresolvable click point) lands at the text
    // end.
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

    // Toggle one persisted turn between user and assistant and rewrite the full
    // history through the identified PUT. Converting to assistant stamps the
    // currently selected model for visible attribution; converting to user drops
    // assistant-only model metadata. The canonical response re-seeds collapse
    // defaults because the latest assistant index may change after the swap.
    const switchMessage = useCallback(async (index: number) => {
        const record = selected();
        if (!record || deleting() || savingEdit()) return;
        const existing = record.messages[index];
        if (!existing || existing.role === 'system') return;
        savingEdit(true);
        try {
            const messages = record.messages.map((candidate, candidateIndex) =>
                candidateIndex === index ? switchMessageRole(candidate, model()) : candidate
            );
            const result = (await replaceConversationMessages(baseUrl, record.conversationId, { messages })).conversation;
            if (selected()?.conversationId === record.conversationId) selected(result);
            const summary = summaryFromRecord(result);
            chats(chats().map((chat) => (chat.conversationId === summary.conversationId ? summary : chat)));
            cancelEdit();
            collapsedTurns(defaultCollapsedIndices(result.messages));
            error('');
        } catch (reason) {
            error(reason instanceof Error ? reason.message : String(reason));
        } finally {
            savingEdit(false);
        }
    }, [baseUrl, cancelEdit, chats, collapsedTurns, deleting, error, model, savingEdit, selected]);

    // Copy any message's raw text to the system clipboard (the per-turn copy
    // action in the controls row under the bubble). The async Clipboard API is
    // preferred; the
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

    // Fork a persisted user/assistant interval into a new conversation. The
    // selected index is inclusive, so forking at a user message copies that
    // user turn and every earlier turn; forking at an assistant message copies
    // the completed exchange. The source record is never rewritten.
    const forkConversation = useCallback(async (index: number) => {
        const record = selected();
        if (!record || deleting() || savingSystemPrompt()) return;
        const message = record.messages[index];
        if (!message || message.role === 'system') return;

        try {
            const prefix = record.messages.slice(0, index + 1);
            const fork = await createConversation(baseUrl, {
                messages: prefix,
                model: record.model || model()
            });
            const forkRecord = (await fetchConversation(baseUrl, fork.conversationId)).conversation;
            const summary = summaryFromRecord(forkRecord);
            // Put the new branch first because it is the most recently created
            // conversation, then make it the active surface for continuation.
            chats([summary, ...chats().filter((chat) => chat.conversationId !== summary.conversationId)]);
            selected(forkRecord);
            model(forkRecord.model);
            rememberModel(forkRecord.model);
            systemPrompt('');
            cancelSystemPromptDraft();
            cancelEdit();
            cancelTitleEdit();
            collapsedTurns(defaultCollapsedIndices(forkRecord.messages));
            selectionPin(true);
            error('');
        } catch (reason) {
            error(reason instanceof Error ? reason.message : String(reason));
        }
    }, [baseUrl, cancelEdit, cancelSystemPromptDraft, cancelTitleEdit, chats, collapsedTurns, deleting, error, model, savingSystemPrompt, selected, selectionPin, systemPrompt]);

    // Commit a rename delivered by the title h1's BLUR (or Enter): the SAME
    // identified PUT the message editor uses — the history round-trips
    // unchanged while the explicit title wins over the server's first-line
    // derivation. Guards mirror commitEdit: the editing flag rejects stale
    // blurs after an Escape-cancel; blank/unchanged titles close without a
    // request (blank titles are forbidden, and the keyed h1 remount restores
    // the persisted one); the conversation guard keeps a blur-commit that
    // raced a chat switch/new chat from resurrecting the old title onto the
    // fresh surface. The request remains independently asynchronous while the
    // title control stays usable.
    const saveTitle = useCallback(async (rawTitle: string) => {
        if (!editingTitle()) return;
        const record = selected();
        const title = rawTitle.trim();
        cancelTitleEdit();
        if (!record || !title || savingTitle() || title === record.title) return;
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
    }, [baseUrl, cancelTitleEdit, chats, editingTitle, error, savingTitle, selected]);

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
    // path, which already returns it). A prompt is normally persisted by its
    // blur handler before this flow starts; the system-prefix fallback remains
    // for a prompt save that failed and is retried together with a user turn.
    // An empty draft adds nothing. A failure before or during
    // streaming saves nothing and restores the composer text for retry.
    // Invoked from the form's onSubmit (event present: prevent the browser's
    // default GET-reload) AND directly from the composer's desktop Enter key
    // (no event: the keydown handler already prevented the newline). The event
    // type follows the styledComponent form's FormEventHandler<HTMLElement>.
    const submit = useCallback(async (event?: React.FormEvent<HTMLElement>) => {
        event?.preventDefault();
        // Voice session still live: end it (dispose = silent, no onEnd) so the transcript already written into the input is exactly what gets sent, and the engine stops rewriting the draft during the provider round-trip.
        if (listening()) {
            recognizer()?.dispose();
            recognizer(null);
            listening(false);
        }
        const text = message().trim();
        const chosenModel = model();
        // A prompt blur save owns the conversation write until it completes;
        // blocking send prevents a concurrent append from omitting the prompt
        // or racing the prompt PUT/create response.
        if (!text || !chosenModel || loading() || savingSystemPrompt()) return;

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
                    messages: [...systemPrefix, ...record.messages, { role: 'user', content: text }, assistantMessage],
                    ...(reply.usage ? { usage: reply.usage } : {})
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
    }, [baseUrl, listening, pendingUser, providerUrl, recognizer, cancelSystemPromptDraft, chats, collapsedTurns, error, loading, message, model, savingSystemPrompt, selected, streaming, systemPrompt]);

    // Voice toggle (rendered by the VoiceButton in ComposerField): one tap
    // starts a single-utterance session whose transcript fills the SAME input
    // draft the user would have typed — pre-typed words survive because every
    // frame appends onto the draft snapshot taken at start (appendTranscript
    // owns the one-space separator); the glyph becomes a stop X, and a second
    // tap DISCARDS the session (silent dispose — no onEnd on purpose: the
    // explicit stop aborts the utterance early, so the partial transcript
    // stays in the input for review/editing and a MANUAL send; it never
    // auto-fires).
    // FINISHED-UTTERANCE AUTO-SEND: when the session ends on its own (onEnd —
    // the final result frame delivers the settled text into the input first,
    // then settles; the engine's later stop/onend are guarded no-ops) and the
    // engine produced at least one transcript frame (voiceTranscript), the
    // request SUBMITS AUTOMATICALLY through the exact same submit() a typed
    // message uses: the draft (pre-typed words + transcript) is sent as-is
    // and the provider round-trip, pending bubble, and persistence run
    // unchanged. onEnd also delivers benign/engine-stop endings; the
    // voiceTranscript gate keeps a no-speech or silent ending from
    // submitting the stale pre-typed draft. Defined AFTER submit on purpose:
    // the onEnd closure calls it, so submit must already be in scope here
    // (previously this hook sat above submit and the finished utterance
    // merely waited for a manual review/send).
    const startListening = useCallback(() => {
        // Toggle off: an EXPLICIT stop keeps the recognized text in the
        // input for review/editing (no auto-send: the user chose to abort
        // before the utterance finished) and clears the listening chrome.
        if (listening()) {
            recognizer()?.dispose();
            recognizer(null);
            listening(false);
            return;
        }
        // API-less browsers (Firefox, jsdom, iOS home-screen/PWA where the ctor is
        // absent): explicit non-blocking error — the conversation stays fully
        // usable with typing, no banner-less dead button. Checked FIRST so an
        // origin that is BOTH insecure and API-less reports the true cause.
        if (!speechRecognitionSupported()) {
            error('Voice input is not supported in this browser.');
            return;
        }
        // SECURE-CONTEXT pre-check: in a non-secure context (plain HTTP from a
        // non-localhost origin — e.g. a phone opening `http://<LAN-IP>`, which
        // is the classic "works on the desktop (localhost) but detects nothing
        // on the phone" case) the engine cannot capture audio. Real Chrome
        // still exposes the constructor AND `start()` still returns normally,
        // so without this guard the session opens, picks up no audio, and
        // silently ends (often via benign no-speech) — the user sees NOTHING.
        // Surface the actionable HTTPS/localhost diagnosis (speechDeniedDetail
        // resolves to the insecure-context message here) instead of starting a
        // doomed session.
        if (!speechContextSecure()) {
            void speechDeniedDetail().then((cause) => error(cause));
            return;
        }
        // Draft + gate capture: the transcript's append base for every frame
        // (the ref write keeps interim delivery out of the re-render race —
        // message() above already holds the pre-session text) and the
        // auto-send gate reset (the PREVIOUS session's frame marker must not
        // bleed into this one).
        speechDraft(message());
        voiceTranscript(false);
        listening(true);
        error('');
        recognizer(createSpeechRecognizer({
            onTranscript: (transcript) => {
                // Interim frames are CUMULATIVE from the session start, each
                // replacing the previous, so the input always reads
                // draft + latest recognized text — nothing doubles up.
                // The FIRST frame of any kind (interim or final) marks the
                // session as having produced speakable text — the
                // finished-utterance auto-send gate at session end reads
                // voiceTranscript. src/api/speech.ts always delivers the
                // final settled text BEFORE settle() fires onEnd, so submit
                // below reads the FULL utterance, not a partial.
                voiceTranscript(true);
                message(appendTranscript(speechDraft(), transcript));
            },
            onError: (detail) => {
                // Real engine failure (denied permission, no microphone,
                // network): the session is over and the display-ready label
                // lands in the non-modal error banner (silent benign codes
                // like 'no-speech' never reach this listener —
                // speechErrorLabel in src/api/speech.ts returns '').
                listening(false);
                // A SILENT denial ('not-allowed' — the browser never asked) is
                // unactionable as a generic banner: the cause is almost always
                // the serving origin (http on a non-localhost) or a sticky
                // site-level block, so swap in the self-diagnosing message
                // (speechDeniedDetail in src/api/speech.ts) instead.
                if (detail === 'Microphone access was denied.') {
                    void speechDeniedDetail().then((cause) => error(cause));
                    return;
                }
                error(detail);
            },
            onEnd: () => {
                // Terminal for any reason (final result, explicit engine
                // stop, silent no-speech): the listening chrome comes off;
                // then, only while the engine actually produced a transcript
                // (voiceTranscript), the finished utterance SUBMITS ITSELF —
                // the input draft at this point is exactly the pre-typed
                // words + the recognized speech, and submit runs the provider
                // round-trip like a typed message (submit's own guards still
                // apply: a blocked send — no model selected, a turn already
                // in flight — leaves the draft in the input for a manual
                // send). A session that ended with no frame submits nothing
                // and the input keeps its pre-session text untouched.
                listening(false);
                if (voiceTranscript()) void submit();
            }
        }));
        // The constructor resolved at the probe above, yet start() can still be
        // refused by the engine (e.g. microphone busy): surface a generic
        // error instead of a session that looks live but never hears.
        if (!recognizer()?.start()) {
            listening(false);
            error('Voice input could not be started.');
        }
    }, [error, listening, message, recognizer, speechDraft, voiceTranscript, submit]);

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
                    selected={selected()?.conversationId === chat.conversationId}
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
                    // Provider waiting/streaming is asynchronous and must not
                    // grey the sidebar. Deletion still owns its own guard so a
                    // second delete cannot race the active DELETE request.
                    disabled={deleting()}
                    aria-label="Delete conversation"
                    title="Delete conversation"
                    data-testid={`delete-chat-${chat.conversationId}`}
                >
                    <CloseIcon size={14} />
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
    // The draft editor is unavailable only while its own persistence/delete flow
    // owns the record. Provider waiting/streaming does not grey or disable this
    // draft's controls, so the dashboard remains responsive during generation.
    const canEditSystemPrompt = !deleting() && !savingSystemPrompt();
    const showSystemPromptControls = !deleting() && !savingSystemPrompt();

    // Options handed to the module-level message renderer; rebuilt every render
    // so the closures always see the latest accessor state.
    const messageOptions: MessageListOptions = {
        editingIndex: editingIndex(),
        // Provider generation is asynchronous UI state, not a reason to disable
        // editing/copying/scroll controls. Only a destructive or history-writing
        // operation suppresses inline editing to avoid concurrent record writes.
        canEdit: !deleting() && !savingSystemPrompt(),
        // Generation does not replace the persisted history until completion,
        // therefore the existing expanded-turn controls remain renderable while
        // loading. Deletion and prompt persistence intentionally remove them
        // because those flows own a changing record surface.
        showControls: !deleting() && !savingSystemPrompt(),
        onEditStart: startEdit,
        onEditCommit: (index, text) => void commitEdit(index, text),
        onEditCancel: cancelEdit,
        onMessageDelete: (index) => void deleteMessage(index),
        onMessageRoleSwitch: (index) => void switchMessage(index),
        onMessageCopy: (content) => void copyMessage(content),
        onMessageFork: (index) => void forkConversation(index),
        collapsedTurns: collapsedTurns(),
        onToggleTurnCollapse: toggleTurnCollapse,
        // Measured sticky gate: which turns' strips currently float (see
        // syncStickyControls); mirrors collapsedTurns as a per-render list.
        stickyTurns: stickyTurns(),
        // Section-local scroll chevrons: each turn's own panel drives the flight.
        onJumpTurnEdge: jumpTurnEdge
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
                        <MenuIcon size={16} />
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
                    <MessageList
                        // Hide platform scrollbar chrome at every breakpoint. The
                        // element remains a real scroll container, so touch, wheel,
                        // keyboard, and section-jump scrolling continue to work
                        // without a reserved right gutter on mobile or desktop.
                        xs={{
                            scrollbarWidth: 'none',
                            '&::-webkit-scrollbar': { display: 'none' }
                        } as unknown as React.CSSProperties}
                        md={{
                            scrollbarWidth: 'none',
                            '&::-webkit-scrollbar': { display: 'none' }
                        } as unknown as React.CSSProperties}
                        data-testid="message-list"
                    >
                        {/* The system prompt turn leads every chat — a regular
                            LEFT-aligned row exactly like the assistant turns.
                            While the record has NO leading system message this
                            is the local-draft form: the bubble carries the
                            saved draft or the literal placeholder "no prompt",
                            and clicking its WORDS makes the BUBBLE ITSELF the
                             inline editor every turn uses (blur persists the
                             prompt, Escape cancels); a copy action appears
                             while the prompt is still represented as a draft,
                             and NO delete
                            cross ever (the system prompt cannot be removed).
                            Once the record leads with a persisted system
                            message, renderMessages draws that turn instead and
                            this block disappears. */}
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
                                     // DOM text (blank → "no prompt"), ESCAPE
                                     // cancels. Keyed 'edit' so the
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
                                    // Click the WORDS to edit (the bubble
                                    // becomes contentEditable, exactly like
                                    // every turn's bubble) — works even on the
                                    // "no prompt" placeholder. Inert while a
                                    // turn streams or a delete runs.
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
                                {/* The draft turn's copy action mirrors the
                                    message-turn rule: it STAYS RENDERED while
                                    the draft's own editor is open, greyed out +
                                    disabled instead of disappearing (the
                                    producing-chrome-never-disappears rule).
                                    Copy still exists only when there is real
                                    saved draft text. */}
                                {showSystemPromptControls && (
                                    // The draft turn joins the same measured
                                    // sticky gate as message turns — its
                                    // sentinel index in stickyTurns is -1 (a
                                    // long saved prompt grows this turn tall
                                    // enough to float exactly like message
                                    // turns; the header label must not be
                                    // covered either).
                                    <TrailingControls floating={stickyTurns().includes(-1)} data-testid="system-prompt-controls">
                                        {/* The draft system turn is a
                                            section like any other: its
                                            chevrons drive the same
                                            jumpTurnEdge flight against its
                                            own wrapper (testid key
                                            "system-prompt-turn"). */}
                                        <TurnJumpPair>
                                            <TurnIconButton type="button" greyed={!canEditSystemPrompt} disabled={!canEditSystemPrompt} onClick={() => jumpTurnEdge('system-prompt-turn', true)} aria-label="Scroll to section top" title="Scroll to section top" data-testid="system-prompt-jump-top"><ChevronUpIcon size={14} /></TurnIconButton>
                                            <TurnIconButton type="button" greyed={!canEditSystemPrompt} disabled={!canEditSystemPrompt} onClick={() => jumpTurnEdge('system-prompt-turn', false)} aria-label="Scroll to section bottom" title="Scroll to section bottom" data-testid="system-prompt-jump-bottom"><ChevronDownIcon size={14} /></TurnIconButton>
                                        </TurnJumpPair>
                                        <TurnActionPair>
                                            {/* Copy mirrors the per-message
                                                action but exists only when
                                                there is real draft text to
                                                copy. */}
                                            {!systemPromptEmpty && showSystemPromptControls && (
                                                <TurnIconButton
                                                    type="button"
                                                    greyed={!canEditSystemPrompt || editingSystemPrompt()}
                                                    disabled={!canEditSystemPrompt || editingSystemPrompt()}
                                                    onClick={() => void copyMessage(systemPrompt())}
                                                    aria-label="Copy system prompt"
                                                    title="Copy system prompt"
                                                    data-testid="copy-system-prompt"
                                                >
                                                    <CopyIcon size={14} />
                                                </TurnIconButton>
                                            )}
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
                                            turn chrome does not jump on completion.
                                            They carry NO controls panel (edit affordances
                                            are hidden mid-stream), hence no section
                                            chevrons either. */}
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
                                // The model picker remains usable while a
                                // response streams; the request already holds
                                // its own model snapshot.
                                disabled={catalog.length === 0}
                            >
                                {catalog.length === 0
                                    ? <option value="">No models available</option>
                                    : modelOptions.map((id) => (
                                        // Values keep the full provider-routed id; labels strip the prefix.
                                        <option key={id} value={id}>{modelLabel(id)}</option>
                                    ))}
                            </ModelSelect>
                        </ModelPicker>
                        <TokenUsage data-testid="token-usage">
                            Total tokens: {selected()?.usage?.total_tokens ?? 0}
                        </TokenUsage>
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
                                 // Provider waiting/streaming does not disable
                                 // drafting the next message; submit's loading
                                 // guard prevents overlapping provider turns.
                                // one row by default: the browser's two-row
                                // textarea default would otherwise survive the
                                // resize effect's 'auto' measurement and lock the
                                // empty composer at two rows
                                rows={1}
                            />
                            {/* Voice input: the mic docks at the input's LEFT edge (always visible —
                                the send arrow's mirror); while listening it is a red stop X. The
                                transcript arrives as the input's value; when the utterance
                                FINISHES the request submits automatically (finished-utterance
                                auto-send — see startListening above). An explicit stop X keeps
                                the partial transcript for review + a manual send. */}
                            <VoiceButton
                                type="button"
                                listening={listening()}
                                onClick={startListening}
                                aria-label={listening() ? 'Stop voice input' : 'Start voice input'}
                                aria-pressed={listening()}
                                title={listening() ? 'Stop voice input' : 'Start voice input'}
                                data-testid="voice-input-button"
                            >
                                {listening() ? <CloseIcon size={16} /> : <MicIcon size={16} />}
                            </VoiceButton>
                            {/* The ">" send arrow lives INSIDE the input box at
                                its right edge, vertically centered in the box,
                                and exists ONLY while the composer is focused
                                (see onFocus/onBlur above). */}
                            {composerFocus() && (
                                <SendButton
                                    type="submit"
                                    // Keep the send affordance styled normally in
                                    // every async state, including after submit
                                    // clears the draft. submit() owns validation
                                    // and rejects overlapping requests; a native
                                    // disabled prop would make the whole composer
                                    // look frozen while the provider streams.
                                    aria-label="Send message"
                                    title="Send message"
                            data-testid="send-chat-button"
                        >
                            <ChevronRightIcon size={16} />
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
