// Deterministic unit tests for the client-side agent registry (src/agents).
// The registry persists agent definitions best-effort in localStorage and
// allocates ids deterministically (lowest free `agent-N`), so every assertion
// below pins exact values.
import { arrayEach } from '@presource/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    AGENT_STORAGE_KEY,
    AVAILABLE_TOOLS,
    agentPrefixMessages,
    appendAgentMessage,
    createAgentDefinition,
    isCodedTool,
    isNativeTool,
    readStoredAgents,
    removeAgentMessage,
    storeAgents,
    toggleAgentTool,
    updateAgentMessage,
    updateAgentMessageRole,
    type AgentDefinition,
    type ToolDefinition
} from './index';

describe('agents registry', () => {
    beforeEach(() => {
        window.localStorage.clear();
    });
    afterEach(() => {
        window.localStorage.clear();
    });

    it('seeds the registry with the NATIVE runtime tools (name only — no source)', () => {
        // Native tools are provided by the runtime: they carry no language
        // and no code, so the Tool tab never renders an implementation.
        expect(AVAILABLE_TOOLS).toEqual([
            { id: 'web-search', name: 'Web search', native: true },
            { id: 'code-interpreter', name: 'Code interpreter', native: true }
        ]);
        // arrayEach passes a rich context object; the entry rides `value`.
        arrayEach(AVAILABLE_TOOLS, (tool) => {
            expect(isNativeTool(tool.value)).toBe(true);
            expect(isCodedTool(tool.value)).toBe(false);
            expect(tool.value.code).toBeUndefined();
            expect(tool.value.language).toBeUndefined();
        });
    });

    it('classifies coded tools (name + JavaScript/TypeScript source) against native ones', () => {
        const native: ToolDefinition = { id: 'web-search', name: 'Web search', native: true };
        const coded: ToolDefinition = {
            id: 'greeting',
            name: 'Greeting',
            native: false,
            language: 'typescript',
            code: 'export const greeting = (name: string): string => `Hello ${name}`;'
        };
        expect(isNativeTool(native)).toBe(true);
        expect(isCodedTool(native)).toBe(false);
        expect(isNativeTool(coded)).toBe(false);
        expect(isCodedTool(coded)).toBe(true);
        // A non-native entry without source is neither shape: the UI would
        // render it as coded-but-empty, which the guard must reject.
        expect(isCodedTool({ id: 'broken', name: 'Broken', native: false })).toBe(false);
        expect(isCodedTool({ id: 'broken', name: 'Broken', native: false, language: 'javascript' })).toBe(false);
    });

    it('creates the first agent as agent-1 with the default name and empty prompt/layout/tools', () => {
        expect(createAgentDefinition([])).toEqual({
            id: 'agent-1',
            name: 'New agent',
            systemPrompt: '',
            messages: [],
            tools: []
        });
    });

    it('allocates the lowest free id, filling gaps left by deletions', () => {
        const existing: AgentDefinition[] = [
            { id: 'agent-1', name: 'A', systemPrompt: '', messages: [], tools: [] },
            { id: 'agent-3', name: 'C', systemPrompt: '', messages: [], tools: [] }
        ];
        expect(createAgentDefinition(existing).id).toBe('agent-2');
        // With the gap filled, the next allocation continues after the max.
        expect(createAgentDefinition([...existing, { id: 'agent-2', name: 'B', systemPrompt: '', messages: [], tools: [] }]).id)
            .toBe('agent-4');
    });

    it('accepts a custom name for the created agent', () => {
        expect(createAgentDefinition([], 'Researcher').name).toBe('Researcher');
    });

    it('toggles a tool id on and off without mutating the input agent', () => {
        const agent: AgentDefinition = { id: 'agent-1', name: 'A', systemPrompt: 'p', messages: [], tools: ['search'] };
        const added = toggleAgentTool(agent, 'calculator');
        expect(added.tools).toEqual(['search', 'calculator']);
        // Pure: the original agent is untouched.
        expect(agent.tools).toEqual(['search']);
        expect(toggleAgentTool(added, 'calculator').tools).toEqual(['search']);
        // Toggling an absent id twice returns to the original set.
        expect(toggleAgentTool(toggleAgentTool(agent, 'x'), 'x').tools).toEqual(['search']);
    });

    it('builds the agent block as system prompt first, then the example conversation in order', () => {
        const agent: AgentDefinition = {
            id: 'agent-1',
            name: 'Researcher',
            systemPrompt: 'You are a careful researcher.',
            messages: [
                { role: 'user', content: 'Find facts.' },
                { role: 'assistant', content: 'Here is what I found.' }
            ],
            tools: []
        };
        // This is the block that REPLACES a chat's own system prompt turn.
        expect(agentPrefixMessages(agent)).toEqual([
            { role: 'system', content: 'You are a careful researcher.' },
            { role: 'user', content: 'Find facts.' },
            { role: 'assistant', content: 'Here is what I found.' }
        ]);
        // No agent → no block at all (the chat keeps its own prompt block).
        expect(agentPrefixMessages(null)).toEqual([]);
        // A blank prompt is dropped; example turns alone still attach.
        expect(agentPrefixMessages({ ...agent, systemPrompt: '   ' })).toEqual([
            { role: 'user', content: 'Find facts.' },
            { role: 'assistant', content: 'Here is what I found.' }
        ]);
        // Blank example turns (a just-added, still-empty row) are dropped.
        expect(agentPrefixMessages({ ...agent, messages: [{ role: 'user', content: '  ' }, { role: 'assistant', content: 'Hi.' }] }))
            .toEqual([
                { role: 'system', content: 'You are a careful researcher.' },
                { role: 'assistant', content: 'Hi.' }
            ]);
    });

    it('grows the chat layout with alternating turns, editable text, role flips, and removals', () => {
        const agent: AgentDefinition = { id: 'agent-1', name: 'A', systemPrompt: 'p', messages: [], tools: [] };
        // An empty layout starts with the USER turn (the agent's opening
        // prompt is its system prompt, not a fabricated assistant line).
        const first = appendAgentMessage(agent);
        expect(first.messages).toEqual([{ role: 'user', content: '' }]);
        // Turns alternate from there on.
        const second = appendAgentMessage(first);
        expect(second.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
        expect(agent.messages).toEqual([]);

        // Text edits target one turn and never mutate the input.
        const edited = updateAgentMessage(second, 1, 'Hello!');
        expect(edited.messages[1].content).toBe('Hello!');
        expect(second.messages[1].content).toBe('');

        // The role switch flips exactly one turn.
        expect(updateAgentMessageRole(edited, 0).messages.map((message) => message.role))
            .toEqual(['assistant', 'assistant']);
        expect(edited.messages.map((message) => message.role)).toEqual(['user', 'assistant']);

        // Removal drops exactly one turn.
        expect(removeAgentMessage(edited, 0).messages).toEqual([{ role: 'assistant', content: 'Hello!' }]);
        expect(edited.messages).toHaveLength(2);
    });

    it('round-trips agents (including their chat layout) through localStorage', () => {
        const agents: AgentDefinition[] = [
            {
                id: 'agent-1',
                name: 'Researcher',
                systemPrompt: 'Find facts.',
                messages: [
                    { role: 'user', content: 'What is 2 + 2?' },
                    { role: 'assistant', content: '4.' }
                ],
                tools: ['search']
            }
        ];
        storeAgents(agents);
        expect(readStoredAgents()).toEqual(agents);
        // The write landed under the documented key.
        expect(JSON.parse(window.localStorage.getItem(AGENT_STORAGE_KEY)!)).toEqual(agents);
    });

    it('loads a legacy agent without a chat layout as an empty layout', () => {
        // Definitions written before agents carried a conversation preset have
        // no `messages` field: they must still load, normalized to [].
        window.localStorage.setItem(AGENT_STORAGE_KEY, JSON.stringify([
            { id: 'agent-1', name: 'Legacy', systemPrompt: 'Old prompt.', tools: [] }
        ]));
        expect(readStoredAgents()).toEqual([
            { id: 'agent-1', name: 'Legacy', systemPrompt: 'Old prompt.', messages: [], tools: [] }
        ]);
    });

    it('degrades corrupt or malformed storage to an empty registry', () => {
        window.localStorage.setItem(AGENT_STORAGE_KEY, '{not json');
        expect(readStoredAgents()).toEqual([]);
        window.localStorage.setItem(AGENT_STORAGE_KEY, JSON.stringify({ nope: true }));
        expect(readStoredAgents()).toEqual([]);
    });

    it('filters malformed entries but keeps well-shaped ones', () => {
        window.localStorage.setItem(AGENT_STORAGE_KEY, JSON.stringify([
            { id: 'agent-1', name: 'Keep', systemPrompt: 'p', messages: [], tools: [] },
            { id: 7, name: 'Bad id', systemPrompt: '', tools: [] },
            { id: 'agent-2', name: 'Bad tools', systemPrompt: '', tools: 'search' },
            // A chat layout may not smuggle in a system turn: the prompt is
            // its own field, so such an entry is malformed.
            { id: 'agent-3', name: 'Bad layout', systemPrompt: '', messages: [{ role: 'system', content: 'x' }], tools: [] },
            'garbage'
        ]));
        expect(readStoredAgents()).toEqual([
            { id: 'agent-1', name: 'Keep', systemPrompt: 'p', messages: [], tools: [] }
        ]);
    });

    it('reads an empty registry when nothing was persisted', () => {
        expect(readStoredAgents()).toEqual([]);
    });
});
