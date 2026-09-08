// Deterministic persistence tests for the agent/tool registry store. The
// layout under test mirrors the conversation store: one folder per record,
// grouped under an `agents`/`tools` subfolder of the database directory
// (<root>/chat-assistant/<collection>/<id>/<singular>.json), so all registry
// families share one database root without colliding.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRecord, ToolRecord } from './registry';
import { createRegistryStore } from './registry-store';

// Temporary roots isolate each test from the repository and from other test workers.
const temporaryRoots: string[] = [];

// Remove temporary files after each test, including the per-record folders created by upsert.
afterEach(() => {
    for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// One exact agent/tool record pair shared across the assertions.
const agent: AgentRecord = {
    agentId: 'agent-1',
    name: 'Researcher',
    systemPrompt: 'You are a careful researcher.',
    tools: ['web-search'],
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:01.000Z'
};

const tool: ToolRecord = {
    toolId: 'tool-1',
    name: 'Greeting',
    native: false,
    language: 'typescript',
    code: 'export const greeting = (name: string): string => `Hello ${name}`;',
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:01.000Z'
};

describe('registry store', () => {
    it('upserts, reads, lists, deletes, and reloads agent records in their own folders', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-assistant-test-'));
        temporaryRoots.push(root);
        const folder = path.join(root, 'chat-assistant', 'agents', 'agent-1');

        const firstStore = createRegistryStore<AgentRecord>(root, 'agents', 'agent.json', 'agentId');
        const stored = firstStore.upsert(agent);
        expect(stored).toEqual(agent);
        // The returned record is detached: mutating it must not touch the file.
        stored.name = 'Mutated';
        expect(firstStore.get('agent-1')).toEqual(agent);
        expect(firstStore.list()).toEqual([agent]);

        // Each agent lives in its own folder under the agents subfolder,
        // holding exactly one document named agent.json.
        expect(fs.existsSync(path.join(folder, 'agent.json'))).toBe(true);
        expect(fs.existsSync(path.join(root, 'chat-assistant', 'agent-1'))).toBe(false);

        // A second store instance reads the same folder, proving request-scoped
        // stores see persisted data.
        expect(createRegistryStore<AgentRecord>(root, 'agents', 'agent.json', 'agentId').get('agent-1')).toEqual(agent);

        // Deletion removes the record's whole folder, so a fresh request scope
        // cannot read the removed record; a missing DELETE stays distinguishable.
        expect(firstStore.delete('agent-1')).toBe(true);
        expect(fs.existsSync(folder)).toBe(false);
        expect(firstStore.get('agent-1')).toBeNull();
        expect(firstStore.delete('agent-1')).toBe(false);
    });

    it('keeps tool records in a sibling collection without colliding with agents', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-assistant-test-'));
        temporaryRoots.push(root);
        const agentStore = createRegistryStore<AgentRecord>(root, 'agents', 'agent.json', 'agentId');
        const toolStore = createRegistryStore<ToolRecord>(root, 'tools', 'tool.json', 'toolId');
        agentStore.upsert(agent);
        toolStore.upsert(tool);

        // The database root holds ONLY the two collection folders; record ids
        // never sit at the database root.
        expect(fs.readdirSync(path.join(root, 'chat-assistant')).sort()).toEqual(['agents', 'tools']);
        expect(fs.readdirSync(path.join(root, 'chat-assistant', 'tools'))).toEqual(['tool-1']);
        expect(fs.existsSync(path.join(root, 'chat-assistant', 'tools', 'tool-1', 'tool.json'))).toBe(true);

        // Each store lists only its own collection.
        expect(agentStore.list()).toEqual([agent]);
        expect(toolStore.list()).toEqual([tool]);
        // Deleting one collection's record leaves the other untouched.
        expect(toolStore.delete('tool-1')).toBe(true);
        expect(agentStore.get('agent-1')).toEqual(agent);
    });

    it('treats missing, non-directory, and malformed entries as absent', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-assistant-test-'));
        temporaryRoots.push(root);
        // Stray entries are planted directly in the agents subfolder, exactly
        // where list() scans.
        const directory = path.join(root, 'chat-assistant', 'agents');
        fs.mkdirSync(path.join(directory, 'broken'), { recursive: true });
        fs.writeFileSync(path.join(directory, 'broken', 'agent.json'), '{not json', 'utf8');
        fs.writeFileSync(path.join(directory, 'stray-file.json'), '{}', 'utf8');
        fs.mkdirSync(path.join(directory, 'empty-folder'));

        const store = createRegistryStore<AgentRecord>(root, 'agents', 'agent.json', 'agentId');
        // Only well-formed per-record folders contribute to the list.
        expect(store.list()).toEqual([]);
        expect(store.get('broken')).toBeNull();
        expect(store.get('empty-folder')).toBeNull();
        expect(store.get('missing')).toBeNull();
        // Nothing was written yet: upsert creates the root directory lazily.
        fs.rmSync(directory, { recursive: true, force: true });
        expect(store.list()).toEqual([]);
    });
});
