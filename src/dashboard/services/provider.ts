// Provider SERVICE facade for the dashboard plugins.
//
// WHAT THIS IS: a thin, React-free wrapper around the OpenAI-compatible client
// in ../../api/provider.ts. Every request still goes through that module — the
// catalog GET (`{base}/models`), the SSE reader loop, the `[DONE]`/usage frame
// handling, the mid-stream `{"error":{...}}` rejection and the usage opt-in are
// NOT reimplemented here. This facade only:
//   1. pins one provider base per client instance (`createProviderClient`), so
//      the plugin never threads a URL through each call,
//   2. projects the catalog into the picker shapes the UI needs (routing ids +
//      aligned display labels), and
//   3. adds abort semantics: a cancelled stream resolves with `aborted: true`
//      (keeping whatever text arrived so far) instead of throwing, while every
//      real failure still rejects with a readable message.
//
// MODEL LABELS — WHY THE ID AND THE LABEL ARE SEPARATE LISTS
// The provider registry routes by the FULL id (`openai/gpt-5.6-sol`), so
// `catalog()` keeps the complete ids as its values — stripping the prefix from
// the VALUES would both break routing and collapse the gateways that serve the
// same base model through different prefixes (`modal/glm-5.3-flash` vs
// `vultr/glm-5.3-flash`). Only the LABELS are shortened, exactly as the shipped
// UI does (components/ChatAssistantApp.tsx:1744-1783): a prefixed id displays
// "base (provider)" and a prefixless id displays the bare name. `labels()` is
// index-aligned with `catalog()`, which is the array form of the component's
// id → label Map (`uniqueModelLabels`).
//
// SORTING follows the shipped rule too: by the STRIPPED model name, so the
// dropdown order and a fresh browser's default model follow model names rather
// than organisation prefixes (components/ChatAssistantApp.tsx:2770-2774).
import { isString } from '@presource/core';
import { fetchProviderModels, streamProviderChatCompletion } from '../../api/provider';
import type { ChatMessage, ConversationRecord } from '../../api/chat-assistant';

// Token accounting reported by a completion. Derived from the wire type rather
// than redeclared, so it can never drift from what storage persists
// (`ConversationRecord['usage']` in ../../api/chat-assistant.ts:44-48).
export type ChatUsage = NonNullable<ConversationRecord['usage']>;

// One streamed completion request. `messages` is the full conversation history;
// the storage-only per-message `model` attribution is stripped by the api
// client before it leaves the browser. `signal` cancels the request.
export interface ProviderStreamRequest {
    model: string;
    messages: ChatMessage[];
    signal?: AbortSignal;
    // Receives the ACCUMULATED assistant text after every content delta — the
    // exact snapshot contract of api/provider.ts's `onSnapshot`.
    onDelta: (accumulated: string) => void;
}

// Settled stream outcome. `aborted` is true when the caller's signal cancelled
// the request; `content` then holds whatever arrived before the cancellation
// (possibly an empty string) and `usage` is absent, because a cancelled stream
// never delivered its final usage frame.
export interface ProviderStreamResult {
    content: string;
    usage?: ChatUsage;
    aborted: boolean;
}

// The provider contract every chat plugin consumes.
export interface ProviderClient {
    catalog(): Promise<string[]>;
    labels(): Promise<string[]>;
    stream(request: ProviderStreamRequest): Promise<ProviderStreamResult>;
}

// Readable, actionable failure for a blank provider base. The shipped UI never
// calls the default app server when the configured offline base is empty
// (components/ChatAssistantApp.tsx:4003-4008); the facade keeps that guard so a
// misconfigured plugin cannot issue a silent request to the wrong origin.
const PROVIDER_BASE_REQUIRED =
    'Configure the provider base URL (for example, http://192.168.50.109:5500/providers/private/v1) to load the model catalog and stream replies — the catalog lives under its /models route and replies stream from /chat/completions; no request is sent while the base is blank.';

// Canonical base form: trimmed and stripped of trailing slashes (the same
// normalization api/offline.ts:84-85 and api/provider.ts:66 apply, so the
// derived routes can never double-slash).
const normalizeBaseUrl = (value: string): string => value.trim().replace(/\/+$/, '');

// Strip the organisation/provider prefix: "zai-org/GLM-5.2-NVFP4" reads
// "GLM-5.2-NVFP4". Mirrors `modelLabel` (components/ChatAssistantApp.tsx:1748
// -1751) — the split point is the FINAL slash.
const strippedModelId = (id: string): string => {
    const slash = id.lastIndexOf('/');
    return slash >= 0 ? id.slice(slash + 1) : id;
};

// Display label for one id: "base (provider)" for a prefixed id, the bare name
// otherwise (prefixless ids have no provider to show). Mirrors
// `uniqueModelLabels` (components/ChatAssistantApp.tsx:1772-1783).
const modelDisplayLabel = (id: string): string => {
    const slash = id.lastIndexOf('/');
    return slash >= 0 ? `${strippedModelId(id)} (${id.slice(0, slash)})` : strippedModelId(id);
};

// True when a rejection is the platform's abort signal rather than a provider
// failure. undici/jsdom surface a cancelled fetch as a DOMException named
// 'AbortError' (some engines use 'TimeoutError' for a timed abort), and
// DOMException does NOT extend Error — so the name is read structurally. The
// api client rethrows the reason untouched, so the name survives to here.
// (A plain `typeof === 'object'` guard, not @presource/core's `isObject`, which
// accepts ONLY plain objects and would reject both Error and DOMException.)
const isAbortError = (reason: unknown): boolean => {
    if (typeof reason !== 'object' || reason === null) return false;
    const name = (reason as { name?: unknown }).name;
    return name === 'AbortError' || name === 'TimeoutError';
};

// Normalize any thrown value into a readable Error. The api client already
// rejects with server-provided text ("Model 'x' not found", the mid-stream
// error frame's message), so an Error passes through untouched; a DOMException
// keeps its own `message`, and only a value with no message at all is
// stringified.
const readableError = (reason: unknown): Error => {
    if (reason instanceof Error) return reason;
    const message = typeof reason === 'object' && reason !== null
        ? (reason as { message?: unknown }).message
        : undefined;
    return new Error(isString(message) && message.length > 0 ? message : String(reason));
};

// Build a provider client bound to one base URL. Pass the online relay base
// (api/provider.ts's `DEFAULT_PROVIDER_URL`) or the offline Settings
// `providerBase` — the standard routes are derived from either identically.
export function createProviderClient(baseUrl: string): ProviderClient {
    const base = normalizeBaseUrl(baseUrl);

    // Every request needs a base; failing loudly beats a relative call that
    // lands on the hosting origin (the GitHub Pages 404 trap documented in
    // api/server-url.ts).
    const requireBase = (): void => {
        if (base.length === 0) throw new Error(PROVIDER_BASE_REQUIRED);
    };

    // Routing ids of the catalog, deduplicated and sorted by stripped name. The
    // envelope parsing lives in api/provider.ts (`fetchProviderModels`), which
    // also owns the error surface for a failed catalog request.
    const fetchCatalog = async (): Promise<string[]> => {
        requireBase();
        const models = await fetchProviderModels(base);
        const ids: string[] = [];
        for (const entry of models) {
            // A blank/non-string id cannot route a completion, and a repeated
            // id would duplicate a <select> option key — both are dropped so
            // `catalog()` and `labels()` stay 1:1 with usable picker rows.
            const id = (entry as { id?: unknown } | undefined)?.id;
            if (!isString(id) || id.length === 0) continue;
            if (ids.includes(id)) continue;
            ids.push(id);
        }
        // Stable sort: rows with an identical stripped name keep the order the
        // provider returned them in, which is what keeps the list deterministic.
        return ids.sort((a, b) => strippedModelId(a).localeCompare(strippedModelId(b)));
    };

    return {
        catalog: fetchCatalog,

        labels: async (): Promise<string[]> => (await fetchCatalog()).map(modelDisplayLabel),

        stream: async (request: ProviderStreamRequest): Promise<ProviderStreamResult> => {
            // An already-cancelled signal never reaches the network at all.
            if (request.signal?.aborted) return { content: '', aborted: true };
            requireBase();

            // The api client hands out ACCUMULATED snapshots; keeping the last
            // one locally is what lets an aborted stream still return the text
            // the user watched arrive instead of discarding it.
            let accumulated = '';
            try {
                const result = await streamProviderChatCompletion(
                    base,
                    request.model,
                    request.messages,
                    (content: string) => {
                        accumulated = content;
                        request.onDelta(content);
                    },
                    request.signal
                );
                // `usage` is only spread when present so the resolved object
                // never carries an explicit undefined (providers that emit no
                // usage frame resolve as `{ content, aborted: false }`).
                return {
                    content: result.content,
                    ...(result.usage ? { usage: result.usage } : {}),
                    aborted: false
                };
            } catch (reason) {
                // Abort is a normal outcome, not a failure: resolve with the
                // partial text and let the caller keep it in the composer.
                if (request.signal?.aborted || isAbortError(reason)) {
                    return { content: accumulated, aborted: true };
                }
                // Pre-stream non-2xx and mid-stream error frames keep rejecting
                // with the provider's own readable message.
                throw readableError(reason);
            }
        }
    };
}
