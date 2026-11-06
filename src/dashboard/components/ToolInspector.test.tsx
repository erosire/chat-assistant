// ToolInspector: the registry rows, the read-only native panel, and the coded tool's
// name / language / source editing.
//
// The split this file exists to pin (ToolInspector.tsx:9-31 explains the why):
//   - a NATIVE tool is runtime-provided, so its panel is the oracle's read-only trio
//     (name, kind, the runtime note) and it carries NO delete control — the store's
//     merge rule re-adds it on the next read (services/registries.ts:43-50, :152-165);
//   - a CODED tool is user data, so name, language and source are fields that persist
//     through `chat.tool.save`, and the row can be removed.
// The harness's tool stubs perform the same cell writes as plugins/tools.ts, so every
// interaction below is asserted through the loop the operator sees: field -> payload
// -> registry cell -> re-rendered field.
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolDefinition } from '../../agents';
import {
    CHAT_ACTIVE_TOOL_STATE,
    CHAT_SIDEBAR_TAB_STATE,
    CHAT_TOOL_CREATE_COMMAND,
    CHAT_TOOL_DELETE_COMMAND,
    CHAT_TOOL_SAVE_COMMAND,
    CHAT_TOOLS_STATE,
    type SidebarTab
} from '../contract';
import { toolKindLabel, ToolInspector } from './ToolInspector';
import { renderWithHarness } from './test-harness';

const NATIVE: ToolDefinition = { id: 'web-search', name: 'Web search', native: true };
const NATIVE_TWO: ToolDefinition = { id: 'code-interpreter', name: 'Code interpreter', native: true };
const CODED: ToolDefinition = {
    id: 'tool-1',
    name: 'Scratchpad',
    native: false,
    language: 'javascript',
    code: 'export function run() { return 1; }'
};

const NATIVE_NOTE =
    'This tool is already available natively \u2014 the runtime provides it, so its implementation is not shown.';

/** Mount the surface; `open` seeds `chat.activeToolId` (null = nothing selected). */
function mountInspector(overrides: { tools?: readonly ToolDefinition[]; open?: string | null } = {}) {
    const view = renderWithHarness(
        <div className="station__region">
            <ToolInspector />
        </div>,
        {
            tools: overrides.tools ?? [NATIVE, NATIVE_TWO, CODED],
            activeToolId: overrides.open === undefined ? NATIVE.id : overrides.open
        }
    );
    return { ...view, tools: () => view.read<readonly ToolDefinition[]>(CHAT_TOOLS_STATE) };
}

afterEach(() => {
    cleanup();
});

describe('the kind label', () => {
    it('names a native entry by what it is not, and a coded entry by its language', () => {
        expect(toolKindLabel(NATIVE)).toBe('Native \u2014 no implementation shown');
        expect(toolKindLabel(CODED)).toBe('JavaScript');
        expect(toolKindLabel({ ...CODED, language: 'typescript' })).toBe('TypeScript');
        // The oracle's ternary falls through to TypeScript for any tag that is not
        // 'javascript', including a partial persisted write with no tag at all.
        expect(toolKindLabel({ id: 'x', name: 'Partial', native: false, code: 'x' })).toBe('TypeScript');
    });
});

describe('the registry rows', () => {
    it('draws the heading, the live count and one row per entry in registry order', () => {
        mountInspector();
        expect(screen.getByTestId('tool-count').textContent).toBe('3');
        const grid = screen.getByTestId('tool-registry');
        const rows = grid.querySelectorAll('.tool');
        expect([...rows].map((row) => row.querySelector('.tool__name')?.textContent)).toEqual([
            'Web search',
            'Code interpreter',
            'Scratchpad'
        ]);
        // Each row's secondary line is the kind label, and the native flag rides on
        // the row so the badge stays a colour decision (tools.css reads `data-native`).
        expect([...rows].map((row) => row.querySelector('.tool__state')?.textContent)).toEqual([
            'Native \u2014 no implementation shown',
            'Native \u2014 no implementation shown',
            'JavaScript'
        ]);
        expect([...rows].map((row) => row.getAttribute('data-native'))).toEqual(['true', 'true', 'false']);
        expect(rows[2].getAttribute('data-selected')).toBe('false');
    });

    it('marks the open row selected and labels every control accessibly', () => {
        mountInspector();
        const open = screen.getByTestId('tool-row-web-search');
        expect(open.getAttribute('data-selected')).toBe('true');
        const pick = screen.getByTestId('tool-pick-web-search');
        expect(pick.getAttribute('aria-current')).toBe('true');
        expect(pick.getAttribute('aria-label')).toBe('Inspect Web search');
        expect(document.querySelectorAll('.tool[data-selected="true"]')).toHaveLength(1);
    });

    it('offers a delete control only on the rows the store can actually remove', () => {
        mountInspector();
        expect(screen.queryByTestId('tool-delete-web-search')).toBeNull();
        expect(screen.queryByTestId('tool-delete-code-interpreter')).toBeNull();
        const remove = screen.getByTestId('tool-delete-tool-1');
        expect(remove.getAttribute('aria-label')).toBe('Delete tool');
        // A sibling of the select control, never nested inside it (the rail's rule).
        const row = screen.getByTestId('tool-row-tool-1');
        expect(within(row).getByTestId('tool-pick-tool-1').contains(remove)).toBe(false);
    });

    it('picks a row into the panel without touching the composer or the busy label', () => {
        const surface = mountInspector();
        fireEvent.click(screen.getByTestId('tool-pick-tool-1'));

        expect(surface.read<string | null>(CHAT_ACTIVE_TOOL_STATE)).toBe('tool-1');
        expect(screen.getByTestId('tool-name-input')).not.toBeNull();
        // Selection is a cell write, not a command: nothing was dispatched.
        expect(surface.callsOf(CHAT_TOOL_SAVE_COMMAND)).toEqual([]);
    });

    it('says so when the registry is empty', () => {
        mountInspector({ tools: [], open: null });
        expect(screen.getByTestId('tools-empty').textContent).toBe('No tools registered.');
        expect(screen.getByTestId('empty-tool-state')).not.toBeNull();
        expect(screen.queryByTestId('tool-registry')).toBeNull();
    });
});

describe('the native panel', () => {
    it('renders the oracle read-only trio and no editing control at all', () => {
        mountInspector();
        const panel = screen.getByTestId('tool-workspace');
        expect(within(panel).getByTestId('tool-workspace-kind-web-search').textContent).toBe(
            'Native \u2014 no implementation shown'
        );
        expect(within(panel).getByTestId('tool-native-note').textContent).toBe(NATIVE_NOTE);
        expect(within(panel).getByText('Web search')).not.toBeNull();
        // A native name cannot be renamed durably (the seed answers the next read),
        // so no field is offered for it, and no source exists to show.
        expect(screen.queryByTestId('tool-name-input')).toBeNull();
        expect(screen.queryByTestId('tool-language-select')).toBeNull();
        expect(screen.queryByTestId('tool-code')).toBeNull();
        expect(panel.querySelector('input, select, textarea')).toBeNull();
    });
});

describe('the coded panel', () => {
    it('binds name, language, kind and source to the selected definition', () => {
        mountInspector({ open: CODED.id });
        const panel = screen.getByTestId('tool-workspace');
        expect((screen.getByTestId('tool-name-input') as HTMLInputElement).value).toBe('Scratchpad');
        expect((screen.getByTestId('tool-language-select') as HTMLSelectElement).value).toBe('javascript');
        expect(within(panel).getByTestId('tool-workspace-kind-tool-1').textContent).toBe('JavaScript');
        const source = screen.getByTestId('tool-code') as HTMLTextAreaElement;
        expect(source.value).toBe('export function run() { return 1; }');
        expect(source.getAttribute('aria-label')).toBe('Tool source');
        // The native explanation belongs to the other shape only.
        expect(screen.queryByTestId('tool-native-note')).toBeNull();
    });

    it('renames the tool and re-renders the field and the row from the registry', () => {
        const surface = mountInspector({ open: CODED.id });
        fireEvent.change(screen.getByTestId('tool-name-input'), { target: { value: 'Scratch pad' } });

        expect(surface.callsOf(CHAT_TOOL_SAVE_COMMAND)).toEqual([{ ...CODED, name: 'Scratch pad' }]);
        expect(surface.tools()).toEqual([NATIVE, NATIVE_TWO, { ...CODED, name: 'Scratch pad' }]);
        expect((screen.getByTestId('tool-name-input') as HTMLInputElement).value).toBe('Scratch pad');
        expect(
            screen.getByTestId('tool-row-tool-1').querySelector('.tool__name')?.textContent
        ).toBe('Scratch pad');
    });

    it('switches the language, which is also the kind line the row shows', () => {
        const surface = mountInspector({ open: CODED.id });
        fireEvent.change(screen.getByTestId('tool-language-select'), { target: { value: 'typescript' } });

        expect(surface.callsOf(CHAT_TOOL_SAVE_COMMAND)).toEqual([{ ...CODED, language: 'typescript' }]);
        expect(screen.getByTestId('tool-workspace-kind-tool-1').textContent).toBe('TypeScript');
        expect(
            screen.getByTestId('tool-row-tool-1').querySelector('.tool__state')?.textContent
        ).toBe('TypeScript');
    });

    it('edits the source in place', () => {
        const surface = mountInspector({ open: CODED.id });
        fireEvent.change(screen.getByTestId('tool-code'), {
            target: { value: 'export function run() { return 2; }' }
        });

        expect(surface.callsOf(CHAT_TOOL_SAVE_COMMAND)).toEqual([
            { ...CODED, code: 'export function run() { return 2; }' }
        ]);
        expect((screen.getByTestId('tool-code') as HTMLTextAreaElement).value).toBe(
            'export function run() { return 2; }'
        );
    });
});

describe('creating and removing a tool', () => {
    it('creates the next coded tool, opens it and moves the rail to the Tool tab', () => {
        const surface = mountInspector({ open: CODED.id });
        fireEvent.click(screen.getByTestId('new-tool-button'));

        // `tool-1` is taken, so the fresh row is `tool-2` (plugins/tools.ts
        // createToolDefinition); the create command is what the button dispatches.
        expect(surface.callsOf(CHAT_TOOL_CREATE_COMMAND)).toEqual([undefined]);
        expect(surface.read<string | null>(CHAT_ACTIVE_TOOL_STATE)).toBe('tool-2');
        expect(surface.read<SidebarTab>(CHAT_SIDEBAR_TAB_STATE)).toBe('tool');
        expect(surface.tools().map((tool) => tool.id)).toEqual(['web-search', 'code-interpreter', 'tool-1', 'tool-2']);

        const created = surface.tools()[3];
        expect((screen.getByTestId('tool-name-input') as HTMLInputElement).value).toBe(created.name);
        expect((screen.getByTestId('tool-code') as HTMLTextAreaElement).value).toBe(created.code);
        expect(screen.getByTestId('tool-row-tool-2').querySelector('.tool__name')?.textContent).toBe('New tool');
        expect(screen.getByTestId('tool-count').textContent).toBe('4');
    });

    it('removes the open coded tool and falls back to the empty selection state', () => {
        const surface = mountInspector({ open: CODED.id });
        fireEvent.click(screen.getByTestId('tool-delete-tool-1'));

        expect(surface.callsOf(CHAT_TOOL_DELETE_COMMAND)).toEqual(['tool-1']);
        expect(surface.tools()).toEqual([NATIVE, NATIVE_TWO]);
        // The deleted row WAS the open one, so the panel has nothing to show.
        expect(surface.read<string | null>(CHAT_ACTIVE_TOOL_STATE)).toBe(null);
        expect(screen.getByTestId('empty-tool-state').textContent).toBe(
            'No tool selectedPick a tool from the sidebar to inspect it here.'
        );
        expect(screen.queryByTestId('tool-workspace')).toBeNull();
    });

    it('keeps the panel open when a different row is deleted', () => {
        const surface = mountInspector({ tools: [NATIVE, CODED], open: NATIVE.id });
        fireEvent.click(screen.getByTestId('tool-delete-tool-1'));

        expect(surface.tools()).toEqual([NATIVE]);
        expect(surface.read<string | null>(CHAT_ACTIVE_TOOL_STATE)).toBe('web-search');
        expect(screen.getByTestId('tool-workspace')).not.toBeNull();
    });
});

describe('the empty selection', () => {
    it('asks for the required action instead of showing a chat', () => {
        const surface = mountInspector({ open: null });
        const empty = screen.getByTestId('empty-tool-state');
        expect(empty.querySelector('strong')?.textContent).toBe('No tool selected');
        expect(empty.querySelector('span')?.textContent).toBe(
            'Pick a tool from the sidebar to inspect it here.'
        );
        // The registry stays usable: the empty panel never hides the rows.
        expect(screen.getByTestId('tool-registry')).not.toBeNull();
        expect(surface.callsOf(CHAT_TOOL_DELETE_COMMAND)).toEqual([]);
    });
});
