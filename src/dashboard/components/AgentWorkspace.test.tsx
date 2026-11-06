// AgentWorkspace: the registry strip, the editor's four sections, and the persistence
// rule that every edit writes the WHOLE patched definition.
//
// BEHAVIOR ORACLE (read-only): src/components/ChatAssistantApp.tsx:4667-4778 (the
// agent surface), :3441-3470 (create / update / delete). The field copy, the role-chip
// labels, the placeholders and the testids below are the oracle's, asserted verbatim —
// that is what "full parity" means for a surface this textural.
//
// The harness's agent stubs perform the same cell writes as plugins/agents.ts, so each
// interaction is checked end to end: keystroke -> `chat.agent.save` payload (exact,
// including the fields that must NOT change) -> registry cell -> re-rendered field,
// row title and counters.
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentDefinition, ToolDefinition } from '../../agents';
import {
    CHAT_ACTIVE_AGENT_STATE,
    CHAT_AGENT_CREATE_COMMAND,
    CHAT_AGENT_DELETE_COMMAND,
    CHAT_AGENT_SAVE_COMMAND,
    CHAT_AGENTS_STATE,
    CHAT_SIDEBAR_TAB_STATE,
    type SidebarTab
} from '../contract';
import { AgentWorkspace } from './AgentWorkspace';
import { renderWithHarness } from './test-harness';

const AGENT_A: AgentDefinition = {
    id: 'agent-1',
    name: 'Scout',
    systemPrompt: 'Search before answering.',
    messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' }
    ],
    tools: ['web-search']
};
const AGENT_B: AgentDefinition = {
    id: 'agent-2',
    name: 'Planner',
    systemPrompt: '',
    messages: [],
    tools: []
};

const TOOLS: ToolDefinition[] = [
    { id: 'web-search', name: 'Web search', native: true },
    { id: 'code-interpreter', name: 'Code interpreter', native: true }
];

const LAYOUT_NOTE =
    "Attached to the start of every chat that uses this agent, replacing the chat's system prompt block.";

/** Mount the surface; `open` seeds `chat.activeAgentId` (null = nothing selected). */
function mountSurface(overrides: {
    agents?: readonly AgentDefinition[];
    tools?: readonly ToolDefinition[];
    open?: string | null;
} = {}) {
    const view = renderWithHarness(
        <div className="station__region">
            <AgentWorkspace />
        </div>,
        {
            agents: overrides.agents ?? [AGENT_A, AGENT_B],
            tools: overrides.tools ?? TOOLS,
            activeAgentId: overrides.open === undefined ? AGENT_A.id : overrides.open
        }
    );
    return { ...view, agents: () => view.read<readonly AgentDefinition[]>(CHAT_AGENTS_STATE) };
}

/** The payloads one command received, as written into the registry cell. */
const savedAgents = (view: { callsOf: (id: string) => unknown[] }): AgentDefinition[] =>
    view.callsOf(CHAT_AGENT_SAVE_COMMAND) as AgentDefinition[];

afterEach(() => {
    cleanup();
});

describe('the registry strip', () => {
    it('draws the caption, the live count and one row per definition in registry order', () => {
        mountSurface();
        expect(screen.getByTestId('agent-count').textContent).toBe('2');
        const list = screen.getByTestId('agent-registry');
        const rows = list.querySelectorAll('.agent');
        expect(rows).toHaveLength(2);
        expect([...rows].map((row) => row.querySelector('.agent__name')?.textContent)).toEqual(['Scout', 'Planner']);
        // Row meta is the oracle's own line: "{messages} turns · {tools} tools" (:4602).
        expect([...rows].map((row) => row.querySelector('.agent__meta')?.textContent)).toEqual([
            '2 turns \u00B7 1 tools',
            '0 turns \u00B7 0 tools'
        ]);
    });

    it('marks the open definition on the row and on its select control', () => {
        mountSurface();
        const open = screen.getByTestId('agent-row-agent-1');
        expect(open.getAttribute('data-selected')).toBe('true');
        const pick = screen.getByTestId('agent-pick-agent-1');
        expect(pick.getAttribute('data-selected')).toBe('true');
        expect(pick.getAttribute('aria-current')).toBe('true');
        expect(pick.getAttribute('aria-label')).toBe('Edit Scout');
        expect(document.querySelectorAll('.agent__pick[aria-current="true"]')).toHaveLength(1);
    });

    it('gives every row a delete control that is a sibling of the select control', () => {
        mountSurface();
        const row = screen.getByTestId('agent-row-agent-1');
        const remove = screen.getByTestId('delete-agent-agent-1');
        const pick = screen.getByTestId('agent-pick-agent-1');
        expect(remove.getAttribute('aria-label')).toBe('Delete agent');
        expect(pick.contains(remove)).toBe(false);
        expect(row.querySelector('.agent__pick > button')).toBeNull();
    });

    it('picks another definition into the editor with no command dispatch at all', () => {
        const surface = mountSurface();
        fireEvent.click(screen.getByTestId('agent-pick-agent-2'));

        // `chat.activeAgentId` has no command id in contract.ts, so the write is the
        // cell itself (see the header note in AgentWorkspace.tsx).
        expect(surface.read<string | null>(CHAT_ACTIVE_AGENT_STATE)).toBe('agent-2');
        expect(savedAgents(surface)).toEqual([]);
        expect((screen.getByTestId('agent-name-input') as HTMLInputElement).value).toBe('Planner');
    });

    it('says so when the registry is empty, and still offers the empty editor state', () => {
        mountSurface({ agents: [], open: null });
        expect(screen.getByTestId('agents-empty').textContent).toBe('No agents yet.');
        expect(screen.queryByTestId('agent-registry')).toBeNull();
        expect(screen.getByTestId('agent-count').textContent).toBe('0');
    });
});

describe('the editor sections', () => {
    it('binds the name and system prompt fields to the open definition', () => {
        mountSurface();
        const editor = screen.getByTestId('agent-workspace');
        const name = screen.getByTestId('agent-name-input') as HTMLInputElement;
        expect(name.value).toBe('Scout');
        expect(name.getAttribute('aria-label')).toBe('Agent name');
        expect(name.getAttribute('placeholder')).toBe('Agent name');

        const prompt = screen.getByTestId('agent-prompt-input') as HTMLTextAreaElement;
        expect(prompt.value).toBe('Search before answering.');
        expect(prompt.getAttribute('aria-label')).toBe('Agent system prompt');
        expect(prompt.getAttribute('placeholder')).toBe('System prompt the agent uses in chat...');
        expect(prompt.getAttribute('rows')).toBe('10');
        // The themed resize grip is part of the field, not of the workspace.
        expect(within(editor).getByTestId('agent-prompt-grip')).not.toBeNull();
    });

    it('labels the chat-layout section exactly like the oracle', () => {
        mountSurface();
        expect(screen.getByTestId('agent-layout-count').textContent).toBe('2 turns');
        expect(screen.getByTestId('agent-layout-note').textContent).toBe(LAYOUT_NOTE);
        const rows = screen.getByTestId('agent-layout-list').querySelectorAll('.agent__row');
        expect(rows).toHaveLength(2);
        expect([...rows].map((row) => (row.querySelector('.agent__role') as HTMLElement).textContent)).toEqual([
            'user',
            'assistant'
        ]);
        expect([...rows].map((row) => row.querySelector('.agent__role')?.getAttribute('aria-label'))).toEqual([
            'Switch user turn to assistant',
            'Switch assistant turn to user'
        ]);
        expect([...rows].map((row) => (row.querySelector('.agent__layout-input') as HTMLTextAreaElement).value)).toEqual([
            'Hi',
            'Hello'
        ]);
        expect([...rows].map((row) => row.querySelector('.agent__layout-input')?.getAttribute('placeholder'))).toEqual([
            'Example user message...',
            'Example assistant reply...'
        ]);
        expect([...rows].map((row) => row.querySelector('.agent__layout-input')?.getAttribute('aria-label'))).toEqual([
            'user turn 1',
            'assistant turn 2'
        ]);
        expect([...rows].map((row) => row.querySelector('.agent__remove-row')?.getAttribute('aria-label'))).toEqual([
            'Remove user turn',
            'Remove assistant turn'
        ]);
        expect(screen.getByTestId('add-agent-message').getAttribute('aria-label')).toBe('Add turn');
    });

    it('renders the allowed-tools tiles from the same definition', () => {
        mountSurface();
        expect((screen.getByTestId('agent-tool-web-search') as HTMLInputElement).checked).toBe(true);
        expect((screen.getByTestId('agent-tool-code-interpreter') as HTMLInputElement).checked).toBe(false);
        expect(screen.getByTestId('agent-tools-count').textContent).toBe('1');
    });

    it('falls back to the required-action state when nothing is open', () => {
        mountSurface({ open: null });
        const empty = screen.getByTestId('empty-agent-state');
        expect(empty.querySelector('strong')?.textContent).toBe('No agent selected');
        expect(empty.querySelector('span')?.textContent).toBe(
            'Pick an agent from the sidebar or create one with "New agent".'
        );
        expect(screen.queryByTestId('agent-workspace')).toBeNull();
        // The strip is still there to pick from, exactly like the oracle's tab body.
        expect(screen.getByTestId('agent-registry')).not.toBeNull();
    });

    it('re-binds the editor when another surface changes the open id', () => {
        const surface = mountSurface();
        act(() => surface.write<string | null>(CHAT_ACTIVE_AGENT_STATE, AGENT_B.id));
        expect((screen.getByTestId('agent-name-input') as HTMLInputElement).value).toBe('Planner');
        expect(screen.getByTestId('agent-layout-count').textContent).toBe('0 turns');
        // A definition with no preset rows draws no list at all (oracle :4702).
        expect(screen.queryByTestId('agent-layout-list')).toBeNull();
    });
});

describe('editing the open definition', () => {
    it('renames it, and the strip row and the store follow the same keystroke', () => {
        const surface = mountSurface();
        fireEvent.change(screen.getByTestId('agent-name-input'), { target: { value: 'Recon' } });

        expect(savedAgents(surface)).toEqual([{ ...AGENT_A, name: 'Recon' }]);
        expect(surface.agents()).toEqual([{ ...AGENT_A, name: 'Recon' }, AGENT_B]);
        expect(
            screen.getByTestId('agent-row-agent-1').querySelector('.agent__name')?.textContent
        ).toBe('Recon');
    });

    it('edits the system prompt without touching any other field', () => {
        const surface = mountSurface();
        fireEvent.change(screen.getByTestId('agent-prompt-input'), {
            target: { value: 'Search twice before answering.' }
        });

        expect(savedAgents(surface)).toEqual([{ ...AGENT_A, systemPrompt: 'Search twice before answering.' }]);
        expect((screen.getByTestId('agent-prompt-input') as HTMLTextAreaElement).value).toBe(
            'Search twice before answering.'
        );
        // The strip's meta line is unchanged: a prompt edit adds no turn.
        expect(screen.getByTestId('agent-layout-count').textContent).toBe('2 turns');
    });

    it('grows the prompt field with the grip while the workspace re-renders around it', () => {
        const { field } = (() => {
            mountSurface();
            const input = screen.getByTestId('agent-prompt-input') as HTMLTextAreaElement;
            fireEvent.keyDown(screen.getByTestId('agent-prompt-grip'), { key: 'ArrowDown' });
            // A cell write re-renders the editor; the drag height is React-invisible
            // (it lives on the node), so it must survive the re-render.
            act(() => undefined);
            return { field: input };
        })();
        expect(field.style.height).toBe('120px');
        fireEvent.change(field, { target: { value: 'Still resizable.' } });
        expect(field.style.height).toBe('120px');
    });

    it('flips a layout row\'s role through the shared editor helper', () => {
        const surface = mountSurface();
        fireEvent.click(screen.getByTestId('agent-message-role-0'));

        // Only the role at index 0 moves; content and order are preserved
        // (src/agents:196-203 updateAgentMessageRole).
        expect(savedAgents(surface)).toEqual([
            {
                ...AGENT_A,
                messages: [
                    { role: 'assistant', content: 'Hi' },
                    { role: 'assistant', content: 'Hello' }
                ]
            }
        ]);
        const rows = screen.getByTestId('agent-layout-list').querySelectorAll('.agent__row');
        expect(rows[0].querySelector('.agent__role')?.textContent).toBe('assistant');
        expect(rows[0].querySelector('.agent__role')?.getAttribute('aria-label')).toBe(
            'Switch assistant turn to user'
        );
    });

    it('edits one row\'s text and leaves the sibling row byte-identical', () => {
        const surface = mountSurface();
        fireEvent.change(screen.getByTestId('agent-message-input-1'), {
            target: { value: 'Hello there' }
        });

        expect(savedAgents(surface)).toEqual([
            {
                ...AGENT_A,
                messages: [
                    { role: 'user', content: 'Hi' },
                    { role: 'assistant', content: 'Hello there' }
                ]
            }
        ]);
        expect((screen.getByTestId('agent-message-input-1') as HTMLTextAreaElement).value).toBe('Hello there');
    });

    it('removes a row, renumbering the rest, and hides the list once it is empty', () => {
        const surface = mountSurface();
        fireEvent.click(screen.getByTestId('remove-agent-message-0'));

        expect(savedAgents(surface)).toEqual([
            { ...AGENT_A, messages: [{ role: 'assistant', content: 'Hello' }] }
        ]);
        expect(screen.getByTestId('agent-layout-count').textContent).toBe('1 turns');
        const rows = screen.getByTestId('agent-layout-list').querySelectorAll('.agent__row');
        expect(rows).toHaveLength(1);
        // The remaining row is now index 0, and its controls follow the new position.
        expect(rows[0].getAttribute('data-testid')).toBe('agent-message-0');
        expect(rows[0].querySelector('.agent__role')?.textContent).toBe('assistant');

        fireEvent.click(screen.getByTestId('remove-agent-message-0'));
        expect(savedAgents(surface)[1]).toEqual({ ...AGENT_A, messages: [] });
        expect(screen.queryByTestId('agent-layout-list')).toBeNull();
        expect(screen.getByTestId('agent-layout-count').textContent).toBe('0 turns');
    });

    it('appends a turn that alternates from the last one', () => {
        const surface = mountSurface();
        fireEvent.click(screen.getByTestId('add-agent-message'));

        // The preset ends on an assistant line, so the new row is the user's
        // (src/agents:176-185 appendAgentMessage; a blank content is deliberate —
        // blank turns are dropped at send time, never stored as empty messages).
        expect(savedAgents(surface)).toEqual([
            { ...AGENT_A, messages: [...AGENT_A.messages, { role: 'user', content: '' }] }
        ]);
        expect(screen.getByTestId('agent-layout-count').textContent).toBe('3 turns');
        const added = screen.getByTestId('agent-message-2');
        expect(added.querySelector('.agent__role')?.textContent).toBe('user');
        expect((added.querySelector('.agent__layout-input') as HTMLTextAreaElement).value).toBe('');
        expect(added.querySelector('.agent__layout-input')?.getAttribute('placeholder')).toBe(
            'Example user message...'
        );
    });

    it('starts an empty preset with the user turn', () => {
        const surface = mountSurface({ open: AGENT_B.id });
        fireEvent.click(screen.getByTestId('add-agent-message'));
        // An empty layout opens with the USER: the agent's own system prompt is not a
        // conversation turn, so no assistant line is fabricated (src/agents:176-185).
        expect(savedAgents(surface)).toEqual([{ ...AGENT_B, messages: [{ role: 'user', content: '' }] }]);
        expect(screen.getByTestId('agent-message-0').querySelector('.agent__role')?.textContent).toBe('user');
    });

    it('toggles an allowed tool through the same save path', () => {
        const surface = mountSurface();
        fireEvent.click(screen.getByTestId('agent-tool-code-interpreter'));

        expect(savedAgents(surface)).toEqual([{ ...AGENT_A, tools: ['web-search', 'code-interpreter'] }]);
        expect((screen.getByTestId('agent-tool-code-interpreter') as HTMLInputElement).checked).toBe(true);
    });
});

describe('creating and deleting a definition', () => {
    it('creates the next free id, opens it and moves the rail to the Agent tab', () => {
        const surface = mountSurface();
        fireEvent.click(screen.getByTestId('new-agent-button'));

        expect(surface.callsOf(CHAT_AGENT_CREATE_COMMAND)).toEqual([undefined]);
        // agent-1 and agent-2 exist, so the fresh row is agent-3.
        expect(surface.read<string | null>(CHAT_ACTIVE_AGENT_STATE)).toBe('agent-3');
        expect(surface.read<SidebarTab>(CHAT_SIDEBAR_TAB_STATE)).toBe('agent');
        expect(surface.agents()).toEqual([AGENT_A, AGENT_B, { id: 'agent-3', name: 'New agent', systemPrompt: '', messages: [], tools: [] }]);
        expect(screen.getByTestId('agent-count').textContent).toBe('3');
        expect((screen.getByTestId('agent-name-input') as HTMLInputElement).value).toBe('New agent');
        expect(screen.getByTestId('agent-layout-count').textContent).toBe('0 turns');
        expect(screen.getByTestId('agent-tools-count').textContent).toBe('0');
    });

    it('deletes the open definition and falls back to the empty state', () => {
        const surface = mountSurface();
        fireEvent.click(screen.getByTestId('delete-agent-agent-1'));

        expect(surface.callsOf(CHAT_AGENT_DELETE_COMMAND)).toEqual(['agent-1']);
        expect(surface.agents()).toEqual([AGENT_B]);
        expect(surface.read<string | null>(CHAT_ACTIVE_AGENT_STATE)).toBe(null);
        expect(screen.queryByTestId('agent-workspace')).toBeNull();
        expect(screen.getByTestId('empty-agent-state')).not.toBeNull();
        expect(screen.getByTestId('agent-count').textContent).toBe('1');
    });

    it('leaves the editor alone when a different row is deleted', () => {
        const surface = mountSurface();
        fireEvent.click(screen.getByTestId('delete-agent-agent-2'));

        expect(surface.agents()).toEqual([AGENT_A]);
        expect(surface.read<string | null>(CHAT_ACTIVE_AGENT_STATE)).toBe('agent-1');
        expect((screen.getByTestId('agent-name-input') as HTMLInputElement).value).toBe('Scout');
    });

    it('deletes a definition whose row was deleted from under the editor without a crash', () => {
        const surface = mountSurface();
        // A store-side write that drops the open id is the same shape as a delete in
        // another surface: the editor re-resolves to null and shows its empty state.
        act(() => surface.write<readonly AgentDefinition[]>(CHAT_AGENTS_STATE, [AGENT_B]));
        expect(screen.queryByTestId('agent-workspace')).toBeNull();
        expect(screen.getByTestId('empty-agent-state')).not.toBeNull();
    });
});
