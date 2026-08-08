// Deterministic tests for the runtime provider API client (models + completions).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderChatCompletion, fetchProviderModels } from './provider';

// A small Response substitute keeps these tests independent from browser network implementations.
const response = (status: number, body: unknown) =>
    ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body
    }) as Response;

// Exact catalog envelope mirrors runtime/endpoint/provider/private/models/service-route.ts.
const catalog = {
    object: 'list',
    data: [
        { id: 'openai/gpt-5.6-sol', object: 'model', created: 1677610602, owned_by: 'localhost', context_length: 262144 },
        { id: 'qwen/makora-pro', object: 'model', created: 1677610602, owned_by: 'localhost', context_length: 262144 }
    ]
};

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

    it('posts the complete history to chat completions with stream disabled and no API key', async () => {
        (fetch as any).mockResolvedValueOnce(response(200, {
            choices: [{ message: { content: 'Provider answer' } }],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }
        }));

        const messages = [
            { role: 'user' as const, content: 'First question' },
            { role: 'assistant' as const, content: 'First answer' },
            { role: 'user' as const, content: 'Second question' }
        ];
        const result = await createProviderChatCompletion(
            'http://test.local/providers/private/v1',
            'openai/gpt-5.6-sol',
            messages
        );

        expect(result).toEqual({
            content: 'Provider answer',
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }
        });
        expect(fetch).toHaveBeenCalledWith('http://test.local/providers/private/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'openai/gpt-5.6-sol', stream: false, messages })
        });
    });

    it('returns only text content when the completion reports no usage', async () => {
        (fetch as any).mockResolvedValueOnce(response(200, {
            choices: [{ message: { content: 'Bare answer' } }]
        }));

        const result = await createProviderChatCompletion(
            'http://test.local/providers/private/v1',
            'qwen/makora-pro',
            [{ role: 'user', content: 'Question' }]
        );

        expect(result).toEqual({ content: 'Bare answer' });
    });

    it('surfaces the provider error message for a failed completion', async () => {
        (fetch as any).mockResolvedValueOnce(response(404, { error: "Model 'missing' not found" }));

        await expect(
            createProviderChatCompletion('/providers/private/v1', 'missing', [{ role: 'user', content: 'Question' }])
        ).rejects.toThrow("Model 'missing' not found");
    });

    it('rejects a completion whose first choice carries no text content', async () => {
        (fetch as any).mockResolvedValueOnce(response(200, { choices: [{ message: {} }] }));

        await expect(
            createProviderChatCompletion('/providers/private/v1', 'openai/gpt-5.6-sol', [{ role: 'user', content: 'Question' }])
        ).rejects.toThrow('Provider chat completion returned no text content');
    });

    it('surfaces the provider error message for a failed model catalog request', async () => {
        (fetch as any).mockResolvedValueOnce(response(500, { error: 'provider registry unavailable' }));

        await expect(fetchProviderModels('/providers/private/v1')).rejects.toThrow('provider registry unavailable');
    });
});
