// Chat Assistant dashboard.
//
// This UI uses only the conversation collection POST and identified resource
// GET/POST/DELETE contract; the server no longer exposes a collection listing.
import React, { useCallback, useEffect } from 'react';
import { arrayEach, isString } from '@presource/core';
import { styledComponent, useStateHook } from '@presource/react';
import {
    addToConversation,
    createConversation,
    fetchConversation,
    DEFAULT_CHAT_ASSISTANT_URL,
    type ChatMessage,
    type ConversationRecord
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

// Full-viewport application frame.
const Page = styledComponent('main', {
    minHeight: '100%',
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: COLORS.page,
    color: COLORS.text
});

// Header keeps the product name and the explicit refresh action visible on every screen size.
const Header = styledComponent('header', {
    minHeight: 64,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    padding: '0 24px',
    borderBottom: `1px solid ${COLORS.border}`,
    backgroundColor: COLORS.panel
});

// Header title uses a separate text element so the button remains accessible and testable.
const HeaderTitle = styledComponent('h1', {
    margin: 0,
    fontSize: 20,
    lineHeight: 1.2,
    fontWeight: 700,
    letterSpacing: 0.2
});

// Layout switches from two columns to one column on narrow screens.
const Workspace = styledComponent('div', {
    flex: 1,
    minHeight: 0,
    display: 'grid',
    gridTemplateColumns: '280px minmax(0, 1fr)'
});

// Conversation navigation is independently scrollable so long histories do not hide the composer.
const Sidebar = styledComponent('aside', {
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    padding: 16,
    borderRight: `1px solid ${COLORS.border}`,
    backgroundColor: COLORS.panel,
    overflowY: 'auto'
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

// Message bubbles are separate styled elements so role-dependent styling never relies on inline objects.
const UserMessage = styledComponent('article', {
    alignSelf: 'flex-end',
    maxWidth: 'min(760px, 86%)',
    padding: '12px 16px',
    borderRadius: '16px 16px 4px 16px',
    backgroundColor: COLORS.user,
    color: COLORS.text,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    lineHeight: 1.5
});

const AssistantMessage = styledComponent('article', {
    alignSelf: 'flex-start',
    maxWidth: 'min(760px, 86%)',
    padding: '12px 16px',
    borderRadius: '16px 16px 16px 4px',
    backgroundColor: COLORS.assistant,
    color: COLORS.text,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    lineHeight: 1.5
});

// System messages remain visible but visually subordinate to user and assistant turns.
const SystemMessage = styledComponent('article', {
    alignSelf: 'center',
    maxWidth: 'min(760px, 86%)',
    padding: '8px 12px',
    borderRadius: 8,
    backgroundColor: COLORS.panelStrong,
    color: COLORS.muted,
    fontSize: 13,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere'
});

// Composer separates the editable input from the message list and exposes a stable test hook.
const Composer = styledComponent('form', {
    display: 'flex',
    alignItems: 'flex-end',
    gap: 12,
    padding: 16,
    borderTop: `1px solid ${COLORS.border}`,
    backgroundColor: COLORS.panel
});

// Textarea grows from one row through eight rows; mouse resizing is disabled so
// the composer height remains controlled by the message content.
const MessageInput = styledComponent('textarea', {
    flex: 1,
    minHeight: 0,
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

// Buttons use a shared solid accent so primary actions remain clear on the dark surface.
const PrimaryButton = styledComponent('button', {
    minHeight: 42,
    padding: '0 16px',
    border: `1px solid ${COLORS.accentStrong}`,
    borderRadius: 8,
    backgroundColor: COLORS.accentStrong,
    color: '#ffffff',
    cursor: 'pointer',
    font: 'inherit',
    fontWeight: 700,
    whiteSpace: 'nowrap'
}) as unknown as React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>>;

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

// Small metadata labels keep model/status details available without competing with message text.
const Metadata = styledComponent('span', {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 1.3
});

// Model metadata receives its own layout component so the JSX contains no inline style object.
const ModelMetadata = styledComponent(Metadata, {
    display: 'block',
    padding: '0 24px 8px'
});

// Error banner is explicit and non-modal so a failed provider request leaves the conversation usable.
const ErrorBanner = styledComponent('div', {
    margin: '0 24px 12px',
    padding: '10px 12px',
    border: '1px solid rgba(255, 156, 156, 0.45)',
    borderRadius: 8,
    backgroundColor: 'rgba(255, 156, 156, 0.08)',
    color: COLORS.danger,
    fontSize: 13
});

// The component accepts a base URL override so tests and embedded deployments can point at another service.
export type ChatAssistantAppProps = {
    baseUrl?: string;
};

// Sidebar entries are derived locally from records because the focused API has no
// collection GET endpoint from which a server-side conversation list can be read.
type ConversationSummary = Pick<ConversationRecord, 'conversationId' | 'title' | 'model' | 'status' | 'messageCount' | 'createdAt' | 'updatedAt'>;

// Convert an API record into message nodes while keeping rendering logic role-specific and explicit.
const renderMessages = (messages: ChatMessage[]): React.ReactNode[] => {
    const nodes: React.ReactNode[] = [];
    arrayEach(messages, ({ index, value: message }) => {
        const key = `${message.role}-${index}`;
        if (message.role === 'user') {
            nodes.push(<UserMessage key={key}>{message.content}</UserMessage>);
        } else if (message.role === 'assistant') {
            nodes.push(<AssistantMessage key={key}>{message.content}</AssistantMessage>);
        } else {
            nodes.push(<SystemMessage key={key}>{message.content}</SystemMessage>);
        }
    });
    return nodes;
};

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
export const ChatAssistantApp: React.FC<ChatAssistantAppProps> = React.memo(({ baseUrl = DEFAULT_CHAT_ASSISTANT_URL }) => {
    // Accessor state follows @presource/react's state-hook contract: read with (), write with (value).
    const chats = useStateHook<ConversationSummary[]>([]);
    const selected = useStateHook<ConversationRecord | null>(null);
    const message = useStateHook('');
    const loading = useStateHook(false);
    const refreshing = useStateHook(false);
    const error = useStateHook('');

    // Keep the editor synchronized with programmatic clears and restored values;
    // the input handler performs the same calculation immediately after typing.
    useEffect(() => {
        const input = document.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]');
        if (input) resizeMessageInput(input);
    }, [message()]);

    // Refresh reads the selected conversation directly because no collection GET exists.
    const refresh = useCallback(async () => {
        const conversationId = selected()?.conversationId;
        if (!conversationId) return;
        refreshing(true);
        try {
            selected((await fetchConversation(baseUrl, conversationId)).conversation);
            error('');
        } catch (reason) {
            error(reason instanceof Error ? reason.message : String(reason));
        } finally {
            refreshing(false);
        }
    }, [baseUrl, error, refreshing, selected]);

    // Select a conversation and fetch its full message history.
    const selectChat = useCallback(async (conversationId: string) => {
        loading(true);
        try {
            selected((await fetchConversation(baseUrl, conversationId)).conversation);
            error('');
        } catch (reason) {
            error(reason instanceof Error ? reason.message : String(reason));
        } finally {
            loading(false);
        }
    }, [baseUrl, error, loading, selected]);

    // Reset the surface without creating a server record until the first message is sent.
    const startNewChat = useCallback(() => {
        selected(null);
        message('');
        error('');
    }, [error, message, selected]);

    // Create an identifier for a new conversation, append the user turn through the
    // identified POST, then GET the canonical completed record for rendering.
    const submit = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const text = message().trim();
        if (!text || loading()) return;

        loading(true);
        error('');
        try {
            const conversationId = selected()?.conversationId ??
                (await createConversation(baseUrl, {})).conversationId;
            await addToConversation(baseUrl, conversationId, { message: text });
            const result = (await fetchConversation(baseUrl, conversationId)).conversation;
            selected(result);
            message('');
            const summary: ConversationSummary = {
                conversationId: result.conversationId,
                title: result.title,
                model: result.model,
                status: result.status,
                messageCount: result.messages.length,
                createdAt: result.createdAt,
                updatedAt: result.updatedAt
            };
            const current = chats();
            const next = current.some((chat) => chat.conversationId === summary.conversationId)
                ? current.map((chat) => (chat.conversationId === summary.conversationId ? summary : chat))
                : [summary, ...current];
            chats(next);
        } catch (reason) {
            error(reason instanceof Error ? reason.message : String(reason));
        } finally {
            loading(false);
        }
    }, [baseUrl, chats, error, loading, message, selected]);

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

    // Render only the selected record; a new chat remains an empty composer until submitted.
    const currentMessages = selected()?.messages ?? [];

    return (
        <Page data-testid="chat-assistant">
            <Header>
                <HeaderTitle>Chat Assistant</HeaderTitle>
                <div>
                    <SecondaryButton type="button" onClick={startNewChat} data-testid="new-chat-button">
                        New chat
                    </SecondaryButton>
                    {' '}
                    <SecondaryButton type="button" onClick={() => void refresh()} disabled={refreshing()} data-testid="refresh-chats-button">
                        {refreshing() ? 'Refreshing...' : 'Refresh'}
                    </SecondaryButton>
                </div>
            </Header>
            <Workspace>
                <Sidebar data-testid="chat-sidebar">
                    <SidebarHeading>
                        <span>Conversations</span>
                        <Metadata>{chats().length}</Metadata>
                    </SidebarHeading>
                    {chatNodes.length > 0 ? chatNodes : <Metadata data-testid="empty-chat-list">No chats yet.</Metadata>}
                </Sidebar>
                <Conversation>
                    <MessageList data-testid="message-list">
                        {currentMessages.length > 0 ? renderMessages(currentMessages) : (
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
                            placeholder="Message the assistant..."
                            aria-label="Message the assistant"
                            data-testid="chat-input"
                            disabled={loading()}
                        />
                        <PrimaryButton type="submit" disabled={loading() || !isString(message()) || !message().trim()} data-testid="send-chat-button">
                            {loading() ? 'Sending...' : 'Send'}
                        </PrimaryButton>
                    </Composer>
                </Conversation>
            </Workspace>
        </Page>
    );
});
