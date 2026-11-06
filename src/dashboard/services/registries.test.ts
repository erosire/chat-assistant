// Deterministic tests for the agent/tool registry SERVICE facades
// (src/dashboard/services/registries.ts). Agents delegate storage entirely to
// ../../agents/index.ts (unchanged localStorage key and degradation rules), so
// these cases pin the upsert/remove ordering the facade adds. Tools add the
// browser-local persistence layer the agents module does not have, so the cases
// pin the seed-first merge, the duplicate-free rule (a native seed can never be
// shadowed), the native/coded shape normalization, and the corrupt-storage
// recovery. jsdom's real localStorage backs every assertion.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    AGENT_STORAGE_KEY,
    AVAILABLE_TOOLS,
    createAgentDefinition,
    storeAgents,
    type AgentDefinition,
    type ToolDefinition
} from '../../agents';
import { createAgentStore, createToolStore, TOOL_STORAGE_KEY } from './registries';

const agent = (id: string, overrides: Partial<AgentDefinition> = {}): AgentDefinition => ({
    id,
    name: `Agent ${id}`,
    systemPrompt: 'Be brief',
    messages: [{ role: 'user', content: 'Hi' }],
    tools: ['web-search'],
    ...overrides
});

const codedTool = (id: string, overrides: Partial<ToolDefinition> = {}): ToolDefinition => ({
    id,
    name: `Tool ${id}`,
    native: false,
    language: 'typescript',
    code: 'export const run = () => 1;',
    ...overrides
});

// The exact native seed list, spelled out so a registry change is a visible
// test failure rather than a silent pass.
const NATIVE_TOOLS: ToolDefinition[] = [
    { id: 'web-search', name: 'Web search', native: true },
    { id: 'code-interpreter', name: 'Code interpreter', native: true }
];

describe('agent store', () => {
    beforeEach(() => window.localStorage.clear());
    afterEach(() => window.localStorage.clear());

    it('starts empty and appends saved agents in insertion order', () => {
        const store = createAgentStore();
        expect(store.list()).toEqual([]);

        store.save(agent('agent-2'));
        store.save(agent('agent-1'));
        expect(store.list()).toEqual([agent('agent-2'), agent('agent-1')]);
        expect(JSON.parse(window.localStorage.getItem(AGENT_STORAGE_KEY) as string)).toEqual([
            agent('agent-2'),
            agent('agent-1')
        ]);
    });

    it('updates an existing id in place instead of re-appending it', () => {
        const store = createAgentStore();
        store.save(agent('agent-1'));
        store.save(agent('agent-2'));
        store.save(agent('agent-1', { name: 'Renamed agent', systemPrompt: 'Answer in one line' }));

        expect(store.list()).toEqual([
            agent('agent-1', { name: 'Renamed agent', systemPrompt: 'Answer in one line' }),
            agent('agent-2')
        ]);
    });

    it('removes by id and treats an unknown id as a no-op', () => {
        const store = createAgentStore();
        store.save(agent('agent-1'));
        store.save(agent('agent-2'));

        store.remove('agent-1');
        expect(store.list()).toEqual([agent('agent-2')]);

        store.remove('missing');
        expect(store.list()).toEqual([agent('agent-2')]);
    });

    it('shares one persisted registry across stores and stays compatible with createAgentDefinition', () => {
        const first = createAgentStore();
        first.save(agent('agent-1'));

        // The module's deterministic lowest-free-id allocator reads the same
        // storage the facade writes.
        expect(createAgentDefinition(createAgentStore().list()).id).toBe('agent-2');

        const second = createAgentStore();
        second.save(agent('agent-2'));
        expect(first.list()).toEqual([agent('agent-1'), agent('agent-2')]);
    });

    it('degrades corrupt storage to an empty registry and normalizes a legacy entry', () => {
        window.localStorage.setItem(AGENT_STORAGE_KEY, 'not json');
        expect(createAgentStore().list()).toEqual([]);

        // A definition written before agents carried a chat layout loads with an
        // empty preset rather than a missing field.
        window.localStorage.setItem(
            AGENT_STORAGE_KEY,
            JSON.stringify([{ id: 'agent-1', name: 'Legacy', systemPrompt: 'Be brief', tools: [] }, { id: 'broken' }])
        );
        expect(createAgentStore().list()).toEqual([
            { id: 'agent-1', name: 'Legacy', systemPrompt: 'Be brief', messages: [], tools: [] }
        ]);
    });
});

describe('tool store', () => {
    beforeEach(() => window.localStorage.clear());
    afterEach(() => window.localStorage.clear());

    it('lists exactly the native seed registry when nothing is saved', () => {
        expect(createToolStore().list()).toEqual(NATIVE_TOOLS);
        expect(window.localStorage.getItem(TOOL_STORAGE_KEY)).toBeNull();
        expect(TOOL_STORAGE_KEY).toBe('chat-assistant:tools');
    });

    it('appends a saved coded tool after the native seeds and keeps its source', () => {
        const store = createToolStore();
        store.save(codedTool('fetcher'));

        expect(store.list()).toEqual([...NATIVE_TOOLS, codedTool('fetcher')]);
        expect(JSON.parse(window.localStorage.getItem(TOOL_STORAGE_KEY) as string)).toEqual([codedTool('fetcher')]);
    });

    it('updates a saved tool in place and never duplicates its id', () => {
        const store = createToolStore();
        store.save(codedTool('fetcher'));
        store.save(codedTool('translator'));
        store.save(codedTool('fetcher', { name: 'Renamed fetcher', code: 'export const run = () => 2;' }));

        expect(store.list()).toEqual([
            ...NATIVE_TOOLS,
            codedTool('fetcher', { name: 'Renamed fetcher', code: 'export const run = () => 2;' }),
            codedTool('translator')
        ]);
    });

    it('lets the native seed win over a hand-saved entry with the same id', () => {
        const store = createToolStore();
        store.save(codedTool('web-search', { name: 'Shadowed search', native: true }));

        expect(store.list()).toEqual(NATIVE_TOOLS);
    });

    it('drops a saved tool on remove and leaves the native seeds unremovable', () => {
        const store = createToolStore();
        store.save(codedTool('fetcher'));

        store.remove('fetcher');
        expect(store.list()).toEqual(NATIVE_TOOLS);

        store.remove('web-search');
        expect(store.list()).toEqual(NATIVE_TOOLS);
    });

    it('strips the implementation from a native tool so a save round-trips canonically', () => {
        const store = createToolStore();
        store.save({ id: 'custom-native', name: 'Custom native', native: true, language: 'javascript', code: 'x' });

        expect(store.list()).toEqual([...NATIVE_TOOLS, { id: 'custom-native', name: 'Custom native', native: true }]);
        expect(JSON.parse(window.localStorage.getItem(TOOL_STORAGE_KEY) as string)).toEqual([
            { id: 'custom-native', name: 'Custom native', native: true }
        ]);
    });

    it('degrades corrupt storage to the native seeds and skips malformed rows', () => {
        window.localStorage.setItem(TOOL_STORAGE_KEY, 'not json');
        expect(createToolStore().list()).toEqual(NATIVE_TOOLS);

        window.localStorage.setItem(TOOL_STORAGE_KEY, JSON.stringify([
            codedTool('ok'),
            { name: 'No id', native: false },
            { id: 'no-name', native: false },
            { id: 'bad-native', name: 'Bad native', native: 'yes' },
            { id: 'bad-language', name: 'Bad language', native: false, language: 'python' },
            { id: 'bad-code', name: 'Bad code', native: false, language: 'javascript', code: '' },
            codedTool('ok')
        ]));
        expect(createToolStore().list()).toEqual([...NATIVE_TOOLS, codedTool('ok')]);
    });

    it('detaches the seed objects so a caller cannot mutate the shared registry', () => {
        const listed = createToolStore().list();
        listed[0].name = 'Mutated seed';

        expect(AVAILABLE_TOOLS[0].name).toBe('Web search');
        expect(createToolStore().list()).toEqual(NATIVE_TOOLS);
    });
});
