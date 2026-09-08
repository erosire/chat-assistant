// Deterministic direct-handler tests for the agent/tool registry storage
// contract. The service is pure storage (identical contract family to the
// conversation handlers): definitions arrive in the request body and are
// persisted; no execution or provider traffic exists here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRecord, RegistryHandlerVariables, ToolRecord } from './registry';
import {
    agentCreate,
    agentDelete,
    agentGet,
    agentList,
    agentPut,
    toolCreate,
    toolDelete,
    toolGet,
    toolList,
    toolPut
} from './registry';
import type { RegistryStore } from './registry-store';

// In-memory stores give handlers the same CRUD seam as the disk store without
// filesystem side effects; records are copied on every crossing so handler
// mutations can never alias the test fixture.
const memoryStore = <RecordType extends object>(idKey: string) => (initial: RecordType[] = []): RegistryStore<RecordType> => {
    const records = [...initial];
    const copy = (record: RecordType): RecordType => ({ ...record });
    const matches = (record: RecordType, id: string) => (record as Record<string, unknown>)[idKey] === id;
    return {
        list: () => records.map(copy),
        get: (id) => {
            const record = records.find((candidate) => matches(candidate, id));
            return record ? copy(record) : null;
        },
        upsert: (record) => {
            const index = records.findIndex((candidate) => matches(candidate, (record as Record<string, unknown>)[idKey] as string));
            if (index < 0) records.push(copy(record));
            else records[index] = copy(record);
            return copy(record);
        },
        delete: (id) => {
            const index = records.findIndex((candidate) => matches(candidate, id));
            if (index < 0) return false;
            records.splice(index, 1);
            return true;
        }
    };
};

const memoryAgentStore = memoryStore<AgentRecord>('agentId');
const memoryToolStore = memoryStore<ToolRecord>('toolId');

// Stable request context and dependency injection make each response exactly assertable.
const context = { req: { method: 'GET' } } as any;
const variables = (
    agentStore?: RegistryStore<AgentRecord>,
    toolStore?: RegistryStore<ToolRecord>,
    ids?: { agentId?: () => string; toolId?: () => string }
): RegistryHandlerVariables => ({ agentStore, toolStore, ...ids });

// A complete stored agent and tool reused by the GET/PUT/DELETE tests.
const existingAgent: AgentRecord = {
    agentId: 'agent-1',
    name: 'Researcher',
    systemPrompt: 'You are a careful researcher.',
    tools: ['web-search'],
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:01.000Z'
};

const existingTool: ToolRecord = {
    toolId: 'tool-1',
    name: 'Greeting',
    native: false,
    language: 'typescript',
    code: 'export const greeting = (name: string): string => `Hello ${name}`;',
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:01.000Z'
};

describe('registry service handlers', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('creates an agent with defaults and returns only its agentId', async () => {
        vi.setSystemTime(new Date('2026-08-06T00:00:00.000Z'));
        const store = memoryAgentStore();

        const result = await agentCreate(
            context,
            { path: {}, query: {}, body: {} },
            variables(store, undefined, { agentId: () => 'agent-created' })
        );

        expect(result).toEqual({ status: 201, response: { agentId: 'agent-created' } });
        expect(store.get('agent-created')).toEqual({
            agentId: 'agent-created',
            name: 'New agent',
            systemPrompt: '',
            tools: [],
            createdAt: '2026-08-06T00:00:00.000Z',
            updatedAt: '2026-08-06T00:00:00.000Z'
        });
    });

    it('creates an agent from a supplied definition and lists agents newest-first', async () => {
        vi.setSystemTime(new Date('2026-08-06T00:00:00.000Z'));
        const store = memoryAgentStore([existingAgent]);

        const result = await agentCreate(
            context,
            { path: {}, query: {}, body: { name: 'Coder', systemPrompt: 'Write code.', tools: ['web-search', 'code-interpreter'] } },
            variables(store, undefined, { agentId: () => 'agent-2' })
        );
        expect(result).toEqual({ status: 201, response: { agentId: 'agent-2' } });

        // The collection GET orders by updatedAt descending: the fixture
        // (00:00:01) sorts before the just-created agent (00:00:00).
        const list = await agentList(context, { path: {}, query: {} }, variables(store));
        expect(list).toEqual({
            status: 200,
            response: {
                agents: [
                    existingAgent,
                    { ...existingAgent, agentId: 'agent-2', name: 'Coder', systemPrompt: 'Write code.', tools: ['web-search', 'code-interpreter'], createdAt: '2026-08-06T00:00:00.000Z', updatedAt: '2026-08-06T00:00:00.000Z' }
                ]
            }
        });
    });

    it('rejects agent creation with an invalid definition', async () => {
        const store = memoryAgentStore();
        const blank = await agentCreate(context, { path: {}, query: {}, body: { name: '   ' } }, variables(store));
        expect(blank).toEqual({ status: 400, response: { error: 'name must be a non-empty string' } });
        const badTools = await agentCreate(context, { path: {}, query: {}, body: { name: 'A', tools: ['x', 7] } }, variables(store));
        expect(badTools).toEqual({ status: 400, response: { error: 'tools must be an array of tool ids' } });
        const badBody = await agentCreate(context, { path: {}, query: {}, body: 'nope' }, variables(store));
        expect(badBody).toEqual({ status: 400, response: { error: 'body must be a JSON object' } });
        expect(store.list()).toEqual([]);
    });

    it('reads, replaces, and deletes one agent through the identified resource', async () => {
        vi.setSystemTime(new Date('2026-08-06T00:00:02.000Z'));
        const store = memoryAgentStore([existingAgent]);

        const get = await agentGet(context, { path: { agent_id: 'agent-1' }, query: {} }, variables(store));
        expect(get).toEqual({ status: 200, response: { agentId: 'agent-1', agent: existingAgent } });

        // PUT replaces the definition fields, retains createdAt, and recomputes
        // updatedAt; the full record returns so callers can re-sync.
        const put = await agentPut(
            context,
            { path: { agent_id: 'agent-1' }, query: {}, body: { name: 'Historian', tools: [] } },
            variables(store)
        );
        expect(put).toEqual({
            status: 200,
            response: {
                agentId: 'agent-1',
                agent: {
                    agentId: 'agent-1',
                    name: 'Historian',
                    // systemPrompt was omitted: the previous value is retained.
                    systemPrompt: 'You are a careful researcher.',
                    tools: [],
                    createdAt: '2026-08-06T00:00:00.000Z',
                    updatedAt: '2026-08-06T00:00:02.000Z'
                }
            }
        });

        const remove = await agentDelete(context, { path: { agent_id: 'agent-1' }, query: {} }, variables(store));
        expect(remove).toEqual({ status: 200, response: { agentId: 'agent-1' } });
        expect(store.get('agent-1')).toBeNull();
    });

    it('answers 404 and 400 for absent agents and missing identifiers', async () => {
        const store = memoryAgentStore();
        expect(await agentGet(context, { path: { agent_id: 'missing' }, query: {} }, variables(store)))
            .toEqual({ status: 404, response: { error: "Agent 'missing' not found" } });
        expect(await agentPut(context, { path: { agent_id: 'missing' }, query: {}, body: { name: 'X' } }, variables(store)))
            .toEqual({ status: 404, response: { error: "Agent 'missing' not found" } });
        expect(await agentDelete(context, { path: { agent_id: 'missing' }, query: {} }, variables(store)))
            .toEqual({ status: 404, response: { error: "Agent 'missing' not found" } });
        expect(await agentGet(context, { path: {}, query: {} }, variables(store)))
            .toEqual({ status: 400, response: { error: 'agent_id is required' } });
    });

    it('creates a native tool without source and a coded tool with language and code', async () => {
        vi.setSystemTime(new Date('2026-08-06T00:00:00.000Z'));
        const store = memoryToolStore();

        const native = await toolCreate(
            context,
            { path: {}, query: {}, body: { name: 'Web search', native: true } },
            variables(undefined, store, { toolId: () => 'tool-native' })
        );
        expect(native).toEqual({ status: 201, response: { toolId: 'tool-native' } });
        expect(store.get('tool-native')).toEqual({
            toolId: 'tool-native',
            name: 'Web search',
            native: true,
            createdAt: '2026-08-06T00:00:00.000Z',
            updatedAt: '2026-08-06T00:00:00.000Z'
        });

        const coded = await toolCreate(
            context,
            {
                path: {},
                query: {},
                body: { name: 'Greeting', language: 'javascript', code: 'export const greeting = () => "Hello";' }
            },
            variables(undefined, store, { toolId: () => 'tool-coded' })
        );
        expect(coded).toEqual({ status: 201, response: { toolId: 'tool-coded' } });
        // native defaults to false for a coded tool; language/code persist verbatim.
        expect(store.get('tool-coded')).toEqual({
            toolId: 'tool-coded',
            name: 'Greeting',
            native: false,
            language: 'javascript',
            code: 'export const greeting = () => "Hello";',
            createdAt: '2026-08-06T00:00:00.000Z',
            updatedAt: '2026-08-06T00:00:00.000Z'
        });

        // Both records share the same timestamp, so the stable sort keeps
        // insertion order (native first, coded second).
        const list = await toolList(context, { path: {}, query: {} }, variables(undefined, store));
        expect(list).toEqual({
            status: 200,
            response: { tools: [store.get('tool-native'), store.get('tool-coded')] }
        });
    });

    it('rejects invalid tool definitions, including mixed native/source shapes', async () => {
        const store = memoryToolStore();
        const blank = await toolCreate(context, { path: {}, query: {}, body: {} }, variables(undefined, store));
        expect(blank).toEqual({ status: 400, response: { error: 'name must be a non-empty string' } });
        const badLanguage = await toolCreate(
            context,
            { path: {}, query: {}, body: { name: 'T', language: 'python', code: 'x' } },
            variables(undefined, store)
        );
        expect(badLanguage).toEqual({ status: 400, response: { error: 'language must be either "javascript" or "typescript"' } });
        const emptyCode = await toolCreate(
            context,
            { path: {}, query: {}, body: { name: 'T', language: 'javascript', code: '   ' } },
            variables(undefined, store)
        );
        expect(emptyCode).toEqual({ status: 400, response: { error: 'code must be a non-empty string' } });
        const nativeWithSource = await toolCreate(
            context,
            { path: {}, query: {}, body: { name: 'T', native: true, language: 'javascript', code: 'x' } },
            variables(undefined, store)
        );
        expect(nativeWithSource).toEqual({
            status: 400,
            response: { error: 'native tools cannot carry language or code (the runtime provides the implementation)' }
        });
        const missingLanguage = await toolCreate(
            context,
            { path: {}, query: {}, body: { name: 'T', code: 'x' } },
            variables(undefined, store)
        );
        expect(missingLanguage).toEqual({ status: 400, response: { error: 'coded tools must declare language ("javascript" or "typescript")' } });
        expect(store.list()).toEqual([]);
    });

    it('replaces and deletes one tool through the identified resource, retaining omitted fields', async () => {
        vi.setSystemTime(new Date('2026-08-06T00:00:02.000Z'));
        const store = memoryToolStore([existingTool]);

        const get = await toolGet(context, { path: { tool_id: 'tool-1' }, query: {} }, variables(undefined, store));
        expect(get).toEqual({ status: 200, response: { toolId: 'tool-1', tool: existingTool } });

        // PUT swaps the coded tool for its renamed version: name is replaced,
        // language/code omitted → retained, updatedAt recomputed.
        const put = await toolPut(
            context,
            { path: { tool_id: 'tool-1' }, query: {}, body: { name: 'Greeter' } },
            variables(undefined, store)
        );
        expect(put).toEqual({
            status: 200,
            response: {
                toolId: 'tool-1',
                tool: {
                    toolId: 'tool-1',
                    name: 'Greeter',
                    native: false,
                    language: 'typescript',
                    code: 'export const greeting = (name: string): string => `Hello ${name}`;',
                    createdAt: '2026-08-06T00:00:00.000Z',
                    updatedAt: '2026-08-06T00:00:02.000Z'
                }
            }
        });

        // Rewriting a coded tool as native drops its implementation (the
        // runtime takes over providing it).
        const nativePut = await toolPut(
            context,
            { path: { tool_id: 'tool-1' }, query: {}, body: { native: true } },
            variables(undefined, store)
        );
        expect(nativePut).toEqual({
            status: 200,
            response: {
                toolId: 'tool-1',
                tool: {
                    toolId: 'tool-1',
                    name: 'Greeter',
                    native: true,
                    createdAt: '2026-08-06T00:00:00.000Z',
                    updatedAt: '2026-08-06T00:00:02.000Z'
                }
            }
        });

        const remove = await toolDelete(context, { path: { tool_id: 'tool-1' }, query: {} }, variables(undefined, store));
        expect(remove).toEqual({ status: 200, response: { toolId: 'tool-1' } });
        expect(store.get('tool-1')).toBeNull();
        expect(await toolDelete(context, { path: { tool_id: 'tool-1' }, query: {} }, variables(undefined, store)))
            .toEqual({ status: 404, response: { error: "Tool 'tool-1' not found" } });
    });

    it('answers 404 and 400 for absent tools and missing identifiers', async () => {
        const store = memoryToolStore();
        expect(await toolGet(context, { path: { tool_id: 'missing' }, query: {} }, variables(undefined, store)))
            .toEqual({ status: 404, response: { error: "Tool 'missing' not found" } });
        expect(await toolPut(context, { path: { tool_id: 'missing' }, query: {}, body: { name: 'X' } }, variables(undefined, store)))
            .toEqual({ status: 404, response: { error: "Tool 'missing' not found" } });
        expect(await toolGet(context, { path: {}, query: {} }, variables(undefined, store)))
            .toEqual({ status: 400, response: { error: 'tool_id is required' } });
    });
});
