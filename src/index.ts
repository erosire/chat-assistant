// Public barrel for the distribution package.
export { App } from './App';
export { ChatAssistantApp } from './components';
// Shared stroke-based SVG icon family, exported for reuse by embedders.
export * from './icons';
export {
    addToConversation,
    createConversation,
    deleteConversation,
    fetchConversation,
    listConversations,
    DEFAULT_CHAT_ASSISTANT_URL
} from './api';
export type {
    ChatMessage,
    ConversationDeleteResponse,
    ConversationGetResponse,
    ConversationListResponse,
    ConversationPostRequest,
    ConversationPostResponse,
    ConversationRecord,
    ConversationSummary
} from './api';
