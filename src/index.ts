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
    DEFAULT_CHAT_ASSISTANT_URL,
    DEFAULT_SERVER_URL
} from './api';
// Deployment host/port config (database API server + inference provider) so
// embedders/tooling can read the network location without parsing URLs.
export {
    DATABASE_API_HOST,
    DATABASE_API_PORT,
    DATABASE_API_URL,
    INFERENCE_PROVIDER_HOST,
    INFERENCE_PROVIDER_PORT,
    INFERENCE_PROVIDER_URL
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
