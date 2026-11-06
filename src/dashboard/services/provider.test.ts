// Deterministic tests for the provider SERVICE facade
// (src/dashboard/services/provider.ts). The facade must delegate: every request
// assertion below pins the EXACT url/method/body the existing api/provider.ts
// client issues (SSE parsing, `[DONE]`, usage opt-in and mid-stream error
// frames all stay there), while the facade adds catalog projection (dedupe +
// stripped-name sorting + aligned "base (provider)" labels) and abort semantics
// (a cancelled stream resolves `aborted: true` with the partial text instead of
// throwing). Success streams use a real ReadableStream Response, exactly like
// src/api/provider.test.ts:19-28; the cancelled streams use a scripted reader so
// the abort reason is deterministic instead of engine-dependent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderClient } from './provider';

const BASE_URL = 'http://test.local/providers/private/v1';

// JSON-envelope Response substitute for the catalog and pre-stream errors.
const response = (status: number, body: unknown) =>
    ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body
    }) as Response;

// Real streaming Response over a ReadableStream (one SSE frame per chunk).
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

// Scripted streaming Response: hands out `frames`, then either throws `error`
// (running `onError` first, so the test can flip the caller's AbortController
// at the exact moment the engine cancels) or reports the end of the stream.
const scriptedResponse = (frames: string[], onError?: () => void, error?: Error) => {
    const encoder = new TextEncoder();
    let index = 0;
    return {
        ok: true,
        status: 200,
        body: {
            getReader: () => ({
                read: async () => {
                    if (index < frames.length) {
                        const value = encoder.encode(frames[index]);
                        index += 1;
                        return { done: false, value };
                    }
                    if (error) {
                        onError?.();
                        throw error;
                    }
                    return { done: true, value: undefined };
                },
                cancel: async () => undefined
            })
        }
    } as unknown as Response;
};

const question = [{ role: 'user' as const, content: 'Question' }];

// The abort-shaped rejection every engine produces for a cancelled fetch.
const abortError = (): Error => new DOMException('This operation was aborted.', 'AbortError');

describe('provider service — catalog', () => {
    beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
    afterEach(() => vi.unstubAllGlobals());

    it('dedupes ids, sorts by the stripped model name, and aligns labels 1:1', async () => {
        // Deliberately unsorted, with a duplicate gateway row, a blank id and a
        // non-string id: the two colliding gateways must BOTH survive (the
        // provider routes by full id) and keep their response order inside the
        // tie, since Array#sort is stable.
        (fetch as any).mockResolvedValue(response(200, {
            object: 'list',
            data: [
                { id: 'vultr/glm-5.3-flash', object: 'model' },
                { id: 'modal/glm-5.3-flash', object: 'model' },
                { id: 'localhost/coder', object: 'model' },
                { id: 'explore', object: 'model' },
                { id: 'vultr/glm-5.3-flash', object: 'model' },
                { id: '' },
                { id: null }
            ]
        }));

        const client = createProviderClient(`${BASE_URL}/`);
        expect(await client.catalog()).toEqual([
            'localhost/coder',
            'explore',
            'vultr/glm-5.3-flash',
            'modal/glm-5.3-flash'
        ]);
        // Values stay the full routing ids; only labels are shortened, and the
        // provider prefix is part of EVERY labelled row.
        expect(await client.labels()).toEqual([
            'coder (localhost)',
            'explore',
            'glm-5.3-flash (vultr)',
            'glm-5.3-flash (modal)'
        ]);
        expect(fetch).toHaveBeenNthCalledWith(1, `${BASE_URL}/models`, { method: 'GET' });
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('rejects a catalog failure with the provider message unchanged', async () => {
        (fetch as any).mockResolvedValueOnce(response(500, { error: 'provider registry unavailable' }));

        await expect(createProviderClient(BASE_URL).catalog()).rejects.toThrow('provider registry unavailable');
    });

    it('never issues a request while the base url is blank', async () => {
        const client = createProviderClient('   ');

        await expect(client.catalog()).rejects.toThrow(/no request is sent while the base is blank/);
        await expect(client.stream({ model: 'x', messages: question, onDelta: () => undefined }))
            .rejects.toThrow(/no request is sent while the base is blank/);
        expect(fetch).not.toHaveBeenCalled();
    });
});

describe('provider service — streaming', () => {
    beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
    afterEach(() => vi.unstubAllGlobals());

    it('forwards accumulated deltas, resolves at [DONE] with usage, and reports no abort', async () => {
        (fetch as any).mockResolvedValueOnce(sseResponse([
            'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Provider"}}]}\n',
            '\ndata: {"choices":[{"index":0,"delta":{"content":" answer"}}]}\n\n',
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}\n\n',
            'data: [DONE]\n\n'
        ]));

        const deltas: string[] = [];
        const result = await createProviderClient(BASE_URL).stream({
            model: 'openai/gpt-5.6-sol',
            messages: question,
            onDelta: (accumulated) => deltas.push(accumulated)
        });

        // The facade adds `aborted` to the api result and nothing else.
        expect(result).toEqual({
            content: 'Provider answer',
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
            aborted: false
        });
        expect(deltas).toEqual(['Provider', 'Provider answer']);
        // An omitted signal must not change the request-init shape at all.
        expect(fetch).toHaveBeenCalledWith(`${BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'openai/gpt-5.6-sol',
                stream: true,
                stream_options: { include_usage: true },
                messages: question
            })
        });
    });

    it('resolves without a usage key when the provider reports none', async () => {
        (fetch as any).mockResolvedValueOnce(sseResponse([
            'data: {"choices":[{"index":0,"delta":{"content":"Bare answer"}}]}\n\n',
            'data: [DONE]\n\n'
        ]));

        const result = await createProviderClient(BASE_URL).stream({
            model: 'qwen/makora-pro',
            messages: question,
            onDelta: () => undefined
        });

        expect(result).toEqual({ content: 'Bare answer', aborted: false });
        expect('usage' in result).toBe(false);
    });

    it('passes the caller signal through to fetch', async () => {
        const controller = new AbortController();
        (fetch as any).mockResolvedValueOnce(sseResponse([
            'data: {"choices":[{"index":0,"delta":{"content":"Answer"}}]}\n\n',
            'data: [DONE]\n\n'
        ]));

        const result = await createProviderClient(BASE_URL).stream({
            model: 'openai/gpt-5.6-sol',
            messages: question,
            signal: controller.signal,
            onDelta: () => undefined
        });

        expect(result).toEqual({ content: 'Answer', aborted: false });
        const [, init] = (fetch as any).mock.calls[0];
        expect(init.signal).toBe(controller.signal);
    });

    it('rejects with the provider message for a mid-stream error frame', async () => {
        (fetch as any).mockResolvedValueOnce(sseResponse([
            'data: {"choices":[{"index":0,"delta":{"content":"Partial"}}]}\n\n',
            'data: {"error":{"message":"Upstream stream terminated","type":"stream_error"}}\n\n'
        ]));

        const deltas: string[] = [];
        await expect(
            createProviderClient(BASE_URL).stream({
                model: 'openai/gpt-5.6-sol',
                messages: question,
                onDelta: (accumulated) => deltas.push(accumulated)
            })
        ).rejects.toThrow('Upstream stream terminated');
        // The partial delta reached the caller before the rejection, and an
        // un-aborted signal means the failure is not reported as an abort.
        expect(deltas).toEqual(['Partial']);
    });

    it('rejects with the provider message when a request fails before streaming', async () => {
        (fetch as any).mockResolvedValueOnce(response(404, { error: "Model 'missing' not found" }));

        await expect(
            createProviderClient(BASE_URL).stream({ model: 'missing', messages: question, onDelta: () => undefined })
        ).rejects.toThrow("Model 'missing' not found");
    });

    it('rejects a completed stream that carried no text', async () => {
        (fetch as any).mockResolvedValueOnce(sseResponse([
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
            'data: [DONE]\n\n'
        ]));

        await expect(
            createProviderClient(BASE_URL).stream({ model: 'openai/gpt-5.6-sol', messages: question, onDelta: () => undefined })
        ).rejects.toThrow('Provider chat completion returned no text content');
    });

    it('resolves the partial text as aborted when the stream is cancelled', async () => {
        const controller = new AbortController();
        (fetch as any).mockResolvedValueOnce(scriptedResponse(
            ['data: {"choices":[{"index":0,"delta":{"content":"Partial"}}]}\n\n'],
            () => controller.abort(),
            abortError()
        ));

        const deltas: string[] = [];
        const result = await createProviderClient(BASE_URL).stream({
            model: 'openai/gpt-5.6-sol',
            messages: question,
            signal: controller.signal,
            onDelta: (accumulated) => deltas.push(accumulated)
        });

        // Abort is a normal outcome: the text the user watched arrive is kept.
        expect(result).toEqual({ content: 'Partial', aborted: true });
        expect(deltas).toEqual(['Partial']);
    });

    it('treats a cancelled read as an abort even when the reason is not an AbortError', async () => {
        // The signal is authoritative: some stacks reject a cancelled body with
        // a plain socket error, and the caller's intent is still an abort.
        const controller = new AbortController();
        (fetch as any).mockResolvedValueOnce(scriptedResponse(
            ['data: {"choices":[{"index":0,"delta":{"content":"Partial"}}]}\n\n'],
            () => controller.abort(),
            new Error('socket hang up')
        ));

        expect(await createProviderClient(BASE_URL).stream({
            model: 'openai/gpt-5.6-sol',
            messages: question,
            signal: controller.signal,
            onDelta: () => undefined
        })).toEqual({ content: 'Partial', aborted: true });
    });

    it('never issues a request for an already-cancelled signal', async () => {
        const controller = new AbortController();
        controller.abort();

        expect(await createProviderClient(BASE_URL).stream({
            model: 'openai/gpt-5.6-sol',
            messages: question,
            signal: controller.signal,
            onDelta: () => undefined
        })).toEqual({ content: '', aborted: true });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('maps an abort-shaped rejection to aborted even without an observable signal', async () => {
        // The fetch was cancelled by the signal the api client handed it, so the
        // AbortError reason alone is enough to report the cancellation.
        (fetch as any).mockResolvedValueOnce(scriptedResponse([], undefined, abortError()));

        expect(await createProviderClient(BASE_URL).stream({
            model: 'openai/gpt-5.6-sol',
            messages: question,
            onDelta: () => undefined
        })).toEqual({ content: '', aborted: true });
    });

    it('rethrows a non-abort stream failure when nothing was cancelled', async () => {
        (fetch as any).mockResolvedValueOnce(scriptedResponse(
            ['data: {"choices":[{"index":0,"delta":{"content":"Partial"}}]}\n\n'],
            undefined,
            new Error('upstream connection reset')
        ));

        await expect(
            createProviderClient(BASE_URL).stream({ model: 'openai/gpt-5.6-sol', messages: question, onDelta: () => undefined })
        ).rejects.toThrow('upstream connection reset');
    });

    it('normalizes a non-Error rejection into a readable message', async () => {
        (fetch as any).mockRejectedValueOnce('provider offline');

        await expect(
            createProviderClient(BASE_URL).stream({ model: 'openai/gpt-5.6-sol', messages: question, onDelta: () => undefined })
        ).rejects.toThrow('provider offline');
    });
});
