// ChatSidebar: the four registries, the row structure rule, and the drawer.
//
// The row structure rule is the one this file exists to pin (behavior oracle
// ChatAssistantApp.tsx:4282-4317): every entry is a positioning context holding
// the SELECT control and the DELETE control as SIBLINGS — nesting them would be
// invalid HTML and a delete click would bubble into a chat selection.
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentDefinition, ToolDefinition } from '../../agents';
import {
    CHAT_ACTIVE_SESSION_STATE,
    CHAT_AUTOSCROLL_STATE,
    CHAT_AUTOSCROLL_TOGGLE_COMMAND,
    CHAT_DRAWER_OPEN_STATE,
    CHAT_SESSIONS_STATE,
    CHAT_SIDEBAR_TAB_STATE,
    type ChatSession
} from '../contract';
import { ChatSidebar } from './ChatSidebar';
import { makeSession, renderWithHarness, stubViewport, type HarnessSeed } from './test-harness';

afterEach(() => {
    cleanup();
});

const SESSIONS: ChatSession[] = [
    makeSession('conv-1', 'Release notes', { messageCount: 4, status: 'complete' }),
    makeSession('conv-2', 'Draft ideas', { messageCount: 1, status: 'pending' })
];

const AGENTS: AgentDefinition[] = [
    {
        id: 'pirate',
        name: 'Pirate',
        systemPrompt: 'Arr, speak like a pirate.',
        messages: [
            { role: 'user', content: 'Ahoy' },
            { role: 'assistant', content: 'Arr' }
        ],
        tools: ['web-search', 'interpreter']
    }
];

const TOOLS: ToolDefinition[] = [
    { id: 'web-search', name: 'Web search', native: true },
    { id: 'chart', name: 'Chart', native: false, language: 'typescript', code: 'export const run = () => 1;' }
];

const SEED: HarnessSeed = { sessions: SESSIONS, activeSessionId: 'conv-1', agents: AGENTS, tools: TOOLS };

describe('the rail shell', () => {
    it('renders the sidebar surface with all four registry tabs', () => {
        renderWithHarness(<ChatSidebar />, SEED);
        const rail = screen.getByTestId('sidebar');
        expect(rail.className).toBe('rail');
        expect(within(rail).getByTestId('sidebar-tab-chat').textContent).toBe('Chat');
        expect(within(rail).getByTestId('sidebar-tab-agent').textContent).toBe('Agent');
        expect(within(rail).getByTestId('sidebar-tab-tool').textContent).toBe('Tool');
        expect(within(rail).getByTestId('sidebar-tab-settings').textContent).toBe('Settings');
        // The store's tab is the selected one, and it is the default.
        expect(screen.getByTestId('sidebar-tab-chat').getAttribute('aria-selected')).toBe('true');
        expect(screen.getByTestId('sidebar-tab-agent').getAttribute('aria-selected')).toBe('false');
    });

    it('switches registries by writing the tab cell, not by executing an unregistered command', () => {
        const view = renderWithHarness(<ChatSidebar />, SEED);
        fireEvent.click(screen.getByTestId('sidebar-tab-agent'));
        expect(view.read<unknown>(CHAT_SIDEBAR_TAB_STATE)).toBe('agent');
        // contract.ts publishes no `chat.tab.set` id; nothing was thrown.
        expect([...view.calls.keys()]).toEqual([]);
        // The conversation list is gone and the agent registry is showing.
        expect(screen.queryByTestId('session-entry-conv-1')).toBeNull();
        expect(screen.getByTestId('agent-entry-pirate')).not.toBeNull();
    });

    it('keeps every tab id in the sidebar-tab-{tab} grammar', () => {
        renderWithHarness(<ChatSidebar />, SEED);
        expect(document.querySelectorAll('[data-testid^="sidebar-tab-"]')).toHaveLength(4);
    });
});

describe('the chat registry', () => {
    it('lists every conversation with its title and "N messages · status" metadata', () => {
        renderWithHarness(<ChatSidebar />, SEED);
        const first = screen.getByTestId('session-entry-conv-1');
        expect(first.querySelector('.rail__title')?.textContent).toBe('Release notes');
        expect(first.querySelector('.rail__meta')?.textContent).toBe('4 messages · complete');
        expect(screen.getByTestId('session-entry-conv-2').querySelector('.rail__meta')?.textContent).toBe(
            '1 messages · pending'
        );
        // The open conversation is marked for assistive tech, not just coloured.
        expect(first.querySelector('.rail__item')?.getAttribute('aria-current')).toBe('true');
        expect(
            screen.getByTestId('session-entry-conv-2').querySelector('.rail__item')?.getAttribute('aria-current')
        ).toBeNull();
    });

    it('selects a conversation through chat.session.select', () => {
        const view = renderWithHarness(<ChatSidebar />, SEED);
        fireEvent.click(screen.getByTestId('session-entry-conv-2').querySelector('.rail__item') as Element);
        expect(view.callsOf('chat.session.select')).toEqual(['conv-2']);
    });

    it('puts the delete affordance BESIDE the select control, never inside it', () => {
        renderWithHarness(<ChatSidebar />, SEED);
        const entry = screen.getByTestId('session-entry-conv-1');
        const select = entry.querySelector('.rail__item') as Element;
        const remove = screen.getByTestId('session-delete-conv-1');
        // A nested <button> would both be invalid HTML and bubble the click into a
        // selection, so nothing but the row's own label lives inside the select.
        expect(select.contains(remove)).toBe(false);
        expect(select.querySelector('button')).toBeNull();
        // The controls sit in a group that is a SIBLING of the select control, both
        // children of the positioned row.
        const group = entry.querySelector('.rail__actions') as Element;
        expect(group.parentElement).toBe(entry);
        expect(select.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(remove.parentElement).toBe(group);
        expect(entry.querySelectorAll('button')).toHaveLength(3); // select + rename + delete
    });

    it('deletes through chat.session.delete with the conversation id', () => {
        const view = renderWithHarness(<ChatSidebar />, SEED);
        fireEvent.click(screen.getByTestId('session-delete-conv-2'));
        expect(view.callsOf('chat.session.delete')).toEqual(['conv-2']);
        // Deleting never selects the row it deletes.
        expect(view.callsOf('chat.session.select')).toEqual([]);
    });

    it('renames inline: the row editor commits on Enter through chat.session.rename', () => {
        const view = renderWithHarness(<ChatSidebar />, SEED);
        fireEvent.click(screen.getByTestId('session-rename-conv-1'));
        const editor = screen.getByTestId('rename-entry-conv-1');
        expect(editor.getAttribute('contenteditable')).toBe('true');
        expect(editor.getAttribute('aria-multiline')).toBe('false');
        expect(editor.textContent).toBe('Release notes');
        editor.textContent = 'Ship notes';
        fireEvent.keyDown(editor, { key: 'Enter' });
        expect(view.callsOf('chat.session.rename')).toEqual([{ sessionId: 'conv-1', title: 'Ship notes' }]);
        // The row is a select control again once the rename finished.
        expect(screen.getByTestId('session-entry-conv-1').querySelector('.rail__item')).not.toBeNull();
    });

    it('aborts a rename on Escape without touching storage', () => {
        const view = renderWithHarness(<ChatSidebar />, SEED);
        fireEvent.click(screen.getByTestId('session-rename-conv-2'));
        const editor = screen.getByTestId('rename-entry-conv-2');
        editor.textContent = 'thrown away';
        fireEvent.keyDown(editor, { key: 'Escape' });
        expect(view.callsOf('chat.session.rename')).toEqual([]);
        expect(screen.getByTestId('session-entry-conv-2').querySelector('.rail__title')?.textContent).toBe(
            'Draft ideas'
        );
    });

    it('creates a chat through chat.session.create', () => {
        const view = renderWithHarness(<ChatSidebar />, SEED);
        fireEvent.click(screen.getByTestId('new-chat-button'));
        expect(view.callsOf('chat.session.create')).toEqual([undefined]);
    });

    it('says so when the registry is empty', () => {
        renderWithHarness(<ChatSidebar />, { ...SEED, sessions: [] });
        expect(screen.getByTestId('empty-chat-list').textContent).toBe('No chats yet.');
        expect(document.querySelectorAll('[data-testid^="session-entry-"]')).toHaveLength(0);
    });

    it('drops the list rows when the store list changes', () => {
        const view = renderWithHarness(<ChatSidebar />, SEED);
        act(() => view.write<readonly ChatSession[]>(CHAT_SESSIONS_STATE, [SESSIONS[1] as ChatSession]));
        expect(screen.queryByTestId('session-entry-conv-1')).toBeNull();
        expect(screen.getByTestId('session-entry-conv-2')).not.toBeNull();
    });

    it('disables the row controls while a save owns the record', () => {
        renderWithHarness(<ChatSidebar />, { ...SEED, status: 'saving' });
        expect((screen.getByTestId('session-delete-conv-1') as HTMLButtonElement).disabled).toBe(true);
        expect(
            (screen.getByTestId('session-entry-conv-1').querySelector('.rail__item') as HTMLButtonElement).disabled
        ).toBe(true);
    });

    it('leaves the rows live while a reply is merely generating', () => {
        renderWithHarness(<ChatSidebar />, { ...SEED, status: 'sending' });
        expect((screen.getByTestId('session-delete-conv-1') as HTMLButtonElement).disabled).toBe(false);
    });
});

describe('the agent and tool registries', () => {
    it('summarises each agent as "N turns · M tools" and selects it through chat.agent.set', () => {
        const view = renderWithHarness(<ChatSidebar />, { ...SEED, sidebarTab: 'agent' });
        const row = screen.getByTestId('agent-entry-pirate');
        expect(row.querySelector('.rail__meta')?.textContent).toBe('2 turns · 2 tools');
        fireEvent.click(row.querySelector('.rail__item') as Element);
        expect(view.callsOf('chat.agent.set')).toEqual(['pirate']);
    });

    it('marks the agent the composer already applies', () => {
        renderWithHarness(<ChatSidebar />, { ...SEED, sidebarTab: 'agent', activeAgentId: 'pirate' });
        expect(screen.getByTestId('agent-entry-pirate').querySelector('.rail__item')?.getAttribute('aria-current')).toBe(
            'true'
        );
    });

    it('labels each tool by kind — native, or the coded language — and offers no select', () => {
        const view = renderWithHarness(<ChatSidebar />, { ...SEED, sidebarTab: 'tool' });
        expect(screen.getByTestId('tool-entry-web-search').querySelector('.rail__meta')?.textContent).toBe('native');
        expect(screen.getByTestId('tool-entry-chart').querySelector('.rail__meta')?.textContent).toBe('typescript');
        // contract.ts has no `chat.tool.select` id, so the row is a plain div: a
        // button that did nothing would be a lie.
        expect(screen.getByTestId('tool-entry-web-search').querySelector('button')).toBeNull();
        expect([...view.calls.keys()]).toEqual([]);
    });

    it('reports empty registries instead of an empty column', () => {
        renderWithHarness(<ChatSidebar />, { ...SEED, sidebarTab: 'agent', agents: [] });
        expect(screen.getByTestId('empty-agent-list').textContent).toBe('No agents yet.');
        renderWithHarness(<ChatSidebar />, { ...SEED, sidebarTab: 'tool', tools: [] });
        expect(screen.getByTestId('empty-tool-list').textContent).toBe('No tools registered.');
    });
});

describe('the settings tab', () => {
    it('mirrors the live cells and toggles the follow switch through its command', () => {
        const view = renderWithHarness(<ChatSidebar />, { ...SEED, sidebarTab: 'settings', usage: { total_tokens: 991 } });
        expect(screen.getByTestId('sidebar-status').textContent).toBe('idle');
        expect(screen.getByTestId('sidebar-turn-count').textContent).toBe('0');
        expect(screen.getByTestId('sidebar-model').textContent).toBe('none');
        expect(screen.getByTestId('sidebar-tokens').textContent).toBe('991');
        const toggle = screen.getByTestId('autoscroll-toggle') as HTMLButtonElement;
        expect(toggle.getAttribute('aria-pressed')).toBe('true');
        fireEvent.click(toggle);
        expect(view.callsOf(CHAT_AUTOSCROLL_TOGGLE_COMMAND)).toEqual([undefined]);
        expect(view.read<boolean>(CHAT_AUTOSCROLL_STATE)).toBe(false);
        expect(screen.getByTestId('autoscroll-toggle').getAttribute('aria-pressed')).toBe('false');
    });
});

describe('the mobile drawer', () => {
    it('slides the rail in and out through chat.drawerOpen', () => {
        const restore = stubViewport('mobile');
        try {
            const view = renderWithHarness(<ChatSidebar />, SEED);
            const rail = screen.getByTestId('sidebar');
            expect(rail.getAttribute('data-open')).toBe('false');
            fireEvent.click(screen.getByTestId('sidebar-toggle'));
            expect(view.read<boolean>(CHAT_DRAWER_OPEN_STATE)).toBe(true);
            expect(rail.getAttribute('data-open')).toBe('true');
            const scrim = screen.getByTestId('sidebar-scrim');
            fireEvent.click(scrim);
            expect(view.read<boolean>(CHAT_DRAWER_OPEN_STATE)).toBe(false);
            expect(screen.queryByTestId('sidebar-scrim')).toBeNull();
        } finally {
            restore();
        }
    });

    it('dismisses itself when the tap picked a conversation or started a chat', () => {
        const restore = stubViewport('mobile');
        try {
            const view = renderWithHarness(<ChatSidebar />, { ...SEED, drawerOpen: true });
            fireEvent.click(screen.getByTestId('session-entry-conv-2').querySelector('.rail__item') as Element);
            expect(view.read<boolean>(CHAT_DRAWER_OPEN_STATE)).toBe(false);
            expect(view.callsOf('chat.session.select')).toEqual(['conv-2']);

            act(() => view.write<boolean>(CHAT_DRAWER_OPEN_STATE, true));
            fireEvent.click(screen.getByTestId('new-chat-button'));
            expect(view.read<boolean>(CHAT_DRAWER_OPEN_STATE)).toBe(false);
            expect(view.callsOf('chat.session.create')).toEqual([undefined]);
        } finally {
            restore();
        }
    });

    it('has no scrim and no toggle above the grid breakpoint, where the rail is a static column', () => {
        const restore = stubViewport('desktop');
        try {
            const view = renderWithHarness(<ChatSidebar />, SEED);
            expect(screen.queryByTestId('sidebar-scrim')).toBeNull();
            // The open cell is inert on desktop: CSS ignores it, so nothing renders.
            act(() => view.write<boolean>(CHAT_DRAWER_OPEN_STATE, true));
            expect(screen.queryByTestId('sidebar-scrim')).toBeNull();
            expect(screen.getByTestId('sidebar').getAttribute('data-open')).toBe('true');
            // Selecting a conversation never dispatches a drawer command either.
            fireEvent.click(screen.getByTestId('session-entry-conv-2').querySelector('.rail__item') as Element);
            expect([...view.calls.keys()]).toEqual(['chat.session.select']);
        } finally {
            restore();
        }
    });
});
