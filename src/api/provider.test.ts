// Deterministic tests for the runtime provider API client (models + streamed completions).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    fetchProviderModels,
    fetchProviderModelsFromUrl,
    streamProviderChatCompletion,
    streamProviderChatCompletionFromUrl
} from './provider';

// JSON-envelope Response substitute for the catalog and pre-stream error cases.
const response = (status: number, body: unknown) =>
    ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body
    }) as Response;

// Real streaming Response over a ReadableStream. Each entry arrives as its own
// network chunk so the reader's partial-line buffering is exercised when a frame
// is split across entries (first two entries of the main test share one SSE frame).
const sseResponse = (chunks: string[]) => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
        }
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};

// Exact catalog envelope mirrors runtime/endpoint/provider/private/models/service-route.ts.
const catalog = {
    object: 'list',
    data: [
        { id: 'openai/gpt-5.6-sol', object: 'model', created: 1677610602, owned_by: 'localhost', context_length: 262144 },
        { id: 'qwen/makora-pro', object: 'model', created: 1677610602, owned_by: 'localhost', context_length: 262144 }
    ]
};

const messages = [
    { role: 'user' as const, content: 'First question' },
    { role: 'assistant' as const, content: 'First answer' },
    { role: 'user' as const, content: 'Second question' }
];

describe('provider API client', () => {
    // Each case receives an isolated fetch mock so URL and payload assertions cannot leak.
    beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
    afterEach(() => vi.unstubAllGlobals());

    it('lists the provider model catalog without any API key', async () => {
        (fetch as any).mockResolvedValueOnce(response(200, catalog));

        const result = await fetchProviderModels('http://test.local/providers/private/v1/');

        expect(result).toEqual(catalog.data);
        // Exactly one header-free GET: the provider injects credentials server-side.
        expect(fetch).toHaveBeenCalledWith('http://test.local/providers/private/v1/models', { method: 'GET' });
    });

    it('streams the completion, snapshots accumulated text, and returns usage', async () => {
        (fetch as any).mockResolvedValueOnce(sseResponse([
            // This frame is deliberately split across the first two network chunks.
            'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Provider"}}]}\n',
            '\ndata: {"choices":[{"index":0,"delta":{"content":" answer"}}]}\n\n',
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}\n\n',
            'data: [DONE]\n\n'
        ]));

        const snapshots: string[] = [];
        const result = await streamProviderChatCompletion(
            'http://test.local/providers/private/v1',
            'openai/gpt-5.6-sol',
            messages,
            (content) => snapshots.push(content)
        );

        expect(result).toEqual({
            content: 'Provider answer',
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }
        });
        expect(snapshots).toEqual(['Provider', 'Provider answer']);
        // The request carries the full history with streaming enabled and no API key.
        expect(fetch).toHaveBeenCalledWith('http://test.local/providers/private/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // Usage is requested explicitly because compatible providers otherwise
            // omit the final usage-only SSE frame consumed by provider.ts.
            body: JSON.stringify({
                model: 'openai/gpt-5.6-sol',
                stream: true,
                stream_options: { include_usage: true },
                messages
            })
        });
    });

    it('strips the storage-only per-message model attribution from the outgoing history', async () => {
        // Persisted messages can carry ChatMessage.model (the "which model produced
        // this response" marker); strict OpenAI-compatible providers reject unknown
        // message fields, so the wire request must contain role + content only.
        (fetch as any).mockResolvedValueOnce(sseResponse([
            'data: {"choices":[{"index":0,"delta":{"content":"Answer"}}]}\n\n',
            'data: [DONE]\n\n'
        ]));

        await streamProviderChatCompletion(
            'http://test.local/providers/private/v1',
            'openai/gpt-5.6-sol',
            [
                { role: 'user', content: 'Question' },
                { role: 'assistant', content: 'Earlier answer', model: 'qwen/makora-pro' }
            ],
            () => undefined
        );

        expect(fetch).toHaveBeenCalledWith('http://test.local/providers/private/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'openai/gpt-5.6-sol',
                stream: true,
                stream_options: { include_usage: true },
                messages: [
                    { role: 'user', content: 'Question' },
                    { role: 'assistant', content: 'Earlier answer' }
                ]
            })
        });
    });

    it('resolves without usage when the model stream reports none', async () => {
        (fetch as any).mockResolvedValueOnce(sseResponse([
            'data: {"choices":[{"index":0,"delta":{"content":"Bare answer"}}]}\n\n',
            'data: [DONE]\n\n'
        ]));

        const result = await streamProviderChatCompletion(
            'http://test.local/providers/private/v1',
            'qwen/makora-pro',
            [{ role: 'user', content: 'Question' }],
            () => undefined
        );

        expect(result).toEqual({ content: 'Bare answer' });
    });

    it('surfaces the provider error message when the request fails before streaming', async () => {
        (fetch as any).mockResolvedValueOnce(response(404, { error: "Model 'missing' not found" }));

        await expect(
            streamProviderChatCompletion('/providers/private/v1', 'missing', [{ role: 'user', content: 'Question' }], () => undefined)
        ).rejects.toThrow("Model 'missing' not found");
    });

    it('rejects when a mid-stream error frame arrives', async () => {
        (fetch as any).mockResolvedValueOnce(sseResponse([
            'data: {"choices":[{"index":0,"delta":{"content":"Partial"}}]}\n\n',
            'data: {"error":{"message":"Upstream stream terminated","type":"stream_error"}}\n\n'
        ]));

        const snapshots: string[] = [];
        await expect(
            streamProviderChatCompletion(
                '/providers/private/v1',
                'openai/gpt-5.6-sol',
                [{ role: 'user', content: 'Question' }],
                (content) => snapshots.push(content)
            )
        ).rejects.toThrow('Upstream stream terminated');
        // The partial delta was already surfaced before the stream aborted.
        expect(snapshots).toEqual(['Partial']);
    });

    it("rejects a stream that completes with no text content", async () => {
        (fetch as any).mockResolvedValueOnce(sseResponse([
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
            'data: [DONE]\n\n'
        ]));

        await expect(
            streamProviderChatCompletion('/providers/private/v1', 'openai/gpt-5.6-sol', [{ role: 'user', content: 'Question' }], () => undefined)
        ).rejects.toThrow('Provider chat completion returned no text content');
    });

    it('surfaces the provider error message for a failed model catalog request', async () => {
        (fetch as any).mockResolvedValueOnce(response(500, { error: 'provider registry unavailable' }));

        await expect(fetchProviderModels('/providers/private/v1')).rejects.toThrow('provider registry unavailable');
    });

    it.each([
        // The offline settings UI configures INDEPENDENT full endpoint URLs
        // (not a shared base): the exact URL (trailing slashes trimmed for
        // stability) is what reaches fetch, with no base-URL derivation.
        'http://offline-models.test:8080/v1/models',
        'http://offline-models.test:8080/other/path/models/'
    ])('fetches the catalog from the independent full model-list URL %s', async (modelListUrl) => {
        (fetch as any).mockResolvedValueOnce(response(200, catalog));

        const result = await fetchProviderModelsFromUrl(modelListUrl);

        expect(result).toEqual(catalog.data);
        const [calledUrl, init] = (fetch as any).mock.calls[0];
        expect(calledUrl).toBe(modelListUrl.replace(/\/+$/, ''));
        expect(init).toEqual({ method: 'GET' });
    });

    it('streams the completion from the independent full stream URL', async () => {
        // A non-standard path proves the URL is used verbatim (no
        // /chat/completions suffix appended, no DEFAULT_PROVIDER_URL).
        (fetch as any).mockResolvedValueOnce(sseResponse([
            'data: {"choices":[{"index":0,"delta":{"content":"Offline"}}]}\n\n',
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n',
            'data: [DONE]\n\n'
        ]));

        const result = await streamProviderChatCompletionFromUrl(
            'http://offline-stream.test:9090/custom/completions/',
            'qwen/makora-pro',
            [{ role: 'user', content: 'Question' }],
            () => undefined
        );

        expect(result).toEqual({
            content: 'Offline',
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
        });
        // The POST lands on the exact configured full URL with the same
        // OpenAI-compatible streaming payload as the base-URL variant.
        expect(fetch).toHaveBeenCalledWith('http://offline-stream.test:9090/custom/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'qwen/makora-pro',
                stream: true,
                stream_options: { include_usage: true },
                messages: [{ role: 'user', content: 'Question' }]
            })
        });
    });

    it('surfaces pre-stream and catalog failures from the independent full URLs', async () => {
        (fetch as any).mockResolvedValueOnce(response(404, { error: "Model 'missing' not found" }));
        await expect(
            streamProviderChatCompletionFromUrl('http://offline-stream.test:9090/v1/chat/completions', 'missing', [{ role: 'user', content: 'Question' }], () => undefined)
        ).rejects.toThrow("Model 'missing' not found");

        (fetch as any).mockResolvedValueOnce(response(500, { error: 'endpoint unreachable' }));
        await expect(fetchProviderModelsFromUrl('http://offline-models.test:8080/v1/models')).rejects.toThrow('endpoint unreachable');
    });
});
