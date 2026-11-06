// Public barrel for the distribution package.
//
// SURFACE NOTE (T6): the rebuild replaced the 5,000-line single component with the
// plugin-composed workstation, and this barrel is the only place the switch is
// visible to an embedder. `App` and `ChatAssistantApp` keep their pre-rebuild names
// and `ChatAssistantApp` keeps its pre-rebuild props ({ baseUrl?, providerUrl? },
// both FULL endpoints — see the jsdoc in src/dashboard/ChatAssistantApp.tsx), so
// every import site survives unchanged. The pre-rebuild component itself
// (src/components/) is retired; its behavior now lives in src/dashboard/plugins.
export { App } from './App';
export { ChatAssistantApp } from './dashboard/ChatAssistantApp';
export type { ChatAssistantAppProps } from './dashboard/ChatAssistantApp';
// Version + branded title (package.json `version`, injected as __APP_VERSION__ by
// vite.config.ts / vitest.config.ts) so a host page can label the build without
// parsing the bundle.
export { APP_VERSION, PRODUCT_TITLE } from './version';
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
