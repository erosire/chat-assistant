// Chat plugin options — the ONE place the deployment URLs enter the chat graph.
//
// WHY THIS FILE EXISTS: `chatPlugins` is a module-level array (the composition
// seam the T3 brief pins), so per-dashboard values cannot be threaded through the
// array itself. They are threaded through the option object instead: every chat
// plugin factory takes this same resolved shape, and `createChatPlugins()` builds
// the array from it. That keeps `chat.ts` a fixed export while still letting a
// test point the storage/provider services at its own origins.
//
// URL MEANING (the drift this fixes — do not "simplify" it):
//   baseUrl      -> the FULL conversation endpoint, i.e. DEFAULT_CHAT_ASSISTANT_URL
//                   ('{origin}/v1/chat-assistant/conversation', api/chat-assistant.ts:16).
//                   It is NOT a bare origin: the api client concatenates '/{id}'
//                   and '' onto it, so an origin here silently repoints every
//                   conversation route at the wrong path. The pre-rebuild prop had
//                   this exact meaning (components/ChatAssistantApp.tsx:2443).
//   providerUrl  -> the FULL provider base, i.e. DEFAULT_PROVIDER_URL
//                   ('{origin}/providers/private/v1', api/provider.ts:26): the
//                   catalog is GET {base}/models and replies stream from
//                   {base}/chat/completions. It is NOT a bare origin either, and
//                   it is NOT the storage origin — the provider listens on a
//                   different port (api/config.ts:56-70; deriving it from the
//                   database origin is the recorded broken-dropdown bug).
import { DEFAULT_CHAT_ASSISTANT_URL } from '../../api/chat-assistant';
import { DEFAULT_PROVIDER_URL } from '../../api/provider';
import { CONVERSATION_POLL_INTERVAL_MS } from '../../api/chat-assistant';

export type ChatPluginOptions = {
    /** Conversation-storage endpoint (default DEFAULT_CHAT_ASSISTANT_URL). */
    baseUrl?: string;
    /** Provider relay base for ONLINE mode (default DEFAULT_PROVIDER_URL). */
    providerUrl?: string;
    /**
     * Poll cadence for an in-flight ('pending') conversation. Defaults to the api
     * constant `CONVERSATION_POLL_INTERVAL_MS`; overridable so a test can drive
     * the R14 poller on a 5ms clock instead of waiting two real seconds.
     */
    pollIntervalMs?: number;
};

export type ChatConfig = {
    baseUrl: string;
    providerUrl: string;
    pollIntervalMs: number;
};

/** Fill every option with its documented deployment default. */
export const describeChatOptions = (options: ChatPluginOptions = {}): ChatConfig => ({
    // A blank/whitespace override is treated as "not configured" and falls back to
    // the deployment default, the same rule the conversations facade applies
    // (services/conversations.ts:110). Trailing slashes are normalized by the api
    // clients themselves, so nothing is stripped here.
    baseUrl: (options.baseUrl ?? '').trim() || DEFAULT_CHAT_ASSISTANT_URL,
    providerUrl: (options.providerUrl ?? '').trim() || DEFAULT_PROVIDER_URL,
    pollIntervalMs:
        options.pollIntervalMs !== undefined && options.pollIntervalMs > 0
            ? options.pollIntervalMs
            : CONVERSATION_POLL_INTERVAL_MS
});
