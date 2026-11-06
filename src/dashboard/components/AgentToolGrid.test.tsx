// AgentToolGrid: one tile per registry entry, the checked set derived from the agent's
// allowed ids, and a toggle that persists through `chat.agent.save`.
//
// The tile is a <label> around a real checkbox (behavior oracle
// ChatAssistantApp.tsx:812-834, 4755-4767), so the assertions go through the control:
// `checked` is the accessible truth and the click is the whole interaction. Because
// the harness's save stub performs the same cell write the production plugin does
// (test-harness.tsx), a click here is checked end to end: payload AND the re-rendered
// checkbox state.
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentDefinition, ToolDefinition } from '../../agents';
import { CHAT_ACTIVE_AGENT_STATE, CHAT_AGENT_SAVE_COMMAND, CHAT_AGENTS_STATE } from '../contract';
import { AgentToolGrid } from './AgentToolGrid';
import { renderWithHarness } from './test-harness';

const TOOLS: ToolDefinition[] = [
    { id: 'web-search', name: 'Web search', native: true },
    { id: 'code-interpreter', name: 'Code interpreter', native: true },
    { id: 'tool-1', name: 'Scratchpad', native: false, language: 'javascript', code: 'run()' }
];

const AGENT: AgentDefinition = {
    id: 'agent-1',
    name: 'Scout',
    systemPrompt: 'Search before answering.',
    messages: [{ role: 'user', content: 'Hi' }],
    tools: ['web-search']
};

/** Mount the grid against the harness with the default registry + open agent. */
function mountGrid(overrides: {
    tools?: readonly ToolDefinition[];
    agents?: readonly AgentDefinition[];
    activeAgentId?: string | null;
} = {}) {
    const view = renderWithHarness(
        <div className="station__region">
            <AgentToolGrid />
        </div>,
        {
            tools: overrides.tools ?? TOOLS,
            agents: overrides.agents ?? [AGENT],
            activeAgentId: overrides.activeAgentId === undefined ? 'agent-1' : overrides.activeAgentId
        }
    );
    return { ...view, agents: () => view.read<readonly AgentDefinition[]>(CHAT_AGENTS_STATE) };
}

afterEach(() => {
    cleanup();
});

describe('the tile grid', () => {
    it('draws the group heading, the enabled count and one tile per registry entry in registry order', () => {
        mountGrid();
        const group = screen.getByTestId('agent-tools');
        expect(within(group).getByText('Allowed tools')).not.toBeNull();
        expect(screen.getByTestId('agent-tools-count').textContent).toBe('1');

        const grid = screen.getByTestId('agent-tool-grid');
        const tiles = grid.querySelectorAll('.agent__tool');
        expect(tiles).toHaveLength(3);
        expect([...tiles].map((tile) => tile.querySelector('.agent__tool-name')?.textContent)).toEqual([
            'Web search',
            'Code interpreter',
            'Scratchpad'
        ]);
        // The empty-registry note is mutually exclusive with the grid.
        expect(screen.queryByTestId('agent-tools-empty')).toBeNull();
    });

    it('checks exactly the tiles in the agent\'s allowed set, on both the input and the tile', () => {
        mountGrid();
        expect((screen.getByTestId('agent-tool-web-search') as HTMLInputElement).checked).toBe(true);
        expect((screen.getByTestId('agent-tool-code-interpreter') as HTMLInputElement).checked).toBe(false);
        expect((screen.getByTestId('agent-tool-tool-1') as HTMLInputElement).checked).toBe(false);
        // The visual state is the tile's own attribute, so CSS never reads the DOM
        // checkbox through a sibling selector of its own.
        expect(screen.getByTestId('agent-tool-web-search').closest('label')?.getAttribute('data-selected')).toBe(
            'true'
        );
        expect(screen.getByTestId('agent-tool-tool-1').closest('label')?.getAttribute('data-selected')).toBe('false');
        expect(document.querySelectorAll('.agent__tool[data-selected="true"]')).toHaveLength(1);
    });

    it('shows the oracle fallback note and no grid while the registry is empty', () => {
        mountGrid({ tools: [] });
        expect(screen.getByTestId('agent-tools-empty').textContent).toBe('No tools available yet.');
        expect(screen.queryByTestId('agent-tool-grid')).toBeNull();
    });

    it('renders nothing at all while no agent is open', () => {
        mountGrid({ activeAgentId: null });
        expect(screen.queryByTestId('agent-tools')).toBeNull();
        expect(document.querySelectorAll('.agent__tool')).toHaveLength(0);
    });
});

describe('toggling a tool', () => {
    it('appends an enabled id and re-renders the tile from the store', () => {
        const grid = mountGrid();
        fireEvent.click(screen.getByTestId('agent-tool-code-interpreter'));

        // The payload is the WHOLE patched definition: identities are immutable and
        // every other field survives verbatim (src/agents:151-154 toggleAgentTool).
        expect(grid.callsOf(CHAT_AGENT_SAVE_COMMAND)).toEqual([
            {
                id: 'agent-1',
                name: 'Scout',
                systemPrompt: 'Search before answering.',
                messages: [{ role: 'user', content: 'Hi' }],
                tools: ['web-search', 'code-interpreter']
            }
        ]);
        // The persisted set follows, and so does the tile plus the count chip.
        expect(grid.agents()[0].tools).toEqual(['web-search', 'code-interpreter']);
        expect((screen.getByTestId('agent-tool-code-interpreter') as HTMLInputElement).checked).toBe(true);
        expect(screen.getByTestId('agent-tools-count').textContent).toBe('2');
    });

    it('removes an id that was already enabled, and can empty the set', () => {
        const grid = mountGrid();
        fireEvent.click(screen.getByTestId('agent-tool-web-search'));

        expect(grid.callsOf(CHAT_AGENT_SAVE_COMMAND)).toEqual([
            {
                id: 'agent-1',
                name: 'Scout',
                systemPrompt: 'Search before answering.',
                messages: [{ role: 'user', content: 'Hi' }],
                tools: []
            }
        ]);
        expect(grid.agents()[0].tools).toEqual([]);
        expect((screen.getByTestId('agent-tool-web-search') as HTMLInputElement).checked).toBe(false);
        expect(screen.getByTestId('agent-tools-count').textContent).toBe('0');
    });

    it('writes the agent the surface has open, never another row of the registry', () => {
        const second: AgentDefinition = {
            id: 'agent-2',
            name: 'Planner',
            systemPrompt: '',
            messages: [],
            tools: []
        };
        const grid = mountGrid({ agents: [AGENT, second], activeAgentId: 'agent-2' });
        fireEvent.click(screen.getByTestId('agent-tool-web-search'));

        expect(grid.callsOf(CHAT_AGENT_SAVE_COMMAND)).toEqual([
            { id: 'agent-2', name: 'Planner', systemPrompt: '', messages: [], tools: ['web-search'] }
        ]);
        // The other definition is untouched, store-wise.
        expect(grid.agents()[0].tools).toEqual(['web-search']);
    });

    it('follows a store-side selection change without remounting', () => {
        const grid = mountGrid({ activeAgentId: null });
        expect(screen.queryByTestId('agent-tools')).toBeNull();
        // The open agent is state, so the group appears as soon as another surface
        // selects one (this is how the rail and the editor stay in step). The write is
        // wrapped in `act` because the store notifies synchronously and React needs to
        // flush the re-render the subscription schedules.
        act(() => grid.write<string | null>(CHAT_ACTIVE_AGENT_STATE, 'agent-1'));
        expect(screen.getByTestId('agent-tools')).not.toBeNull();
        expect((screen.getByTestId('agent-tool-web-search') as HTMLInputElement).checked).toBe(true);
    });
});
