// Shell + composition conformance for the ASSEMBLED workstation (updated by T6).
//
// The skeleton version of this file pinned the two-plugin graph and the placeholder
// contributions. The graph is now complete, so what is pinned here is the final
// shape, and every assertion is an EXACT value, because these are the invariants a
// downstream plugin author would otherwise rediscover by debugging:
//
//   1. the contract exports every id the rebuild was specified with;
//   2. `createChatDashboard()` schedules exactly the 14 plugins of the final graph,
//      in the framework's deterministic order (layout -> theme -> the chat set ->
//      the add-ons, with the chat core before everything that resolves its cells);
//   3. the skin cells default to ink/comfortable/full with NO matchMedia (jsdom),
//      i.e. the prefers() fallback really does land on the documented default;
//   4. each region channel holds the order-0 layout descriptor AND its real owner,
//      and the owner is what renders (the winner-takes-region rule documented in
//      WorkstationShell.tsx:62-81 and plugins/surfaces.ts's band table);
//   5. a later, higher-ordered contribution replaces ONE column and leaves the
//      other two owners untouched — the feature-blindness proof: the probe plugin is
//      something the shell has never heard of, and a DESCRIPTOR contribution still
//      gets the panel chrome;
//   6. ChatAssistantApp survives React 18 StrictMode's setup->cleanup->setup cycle:
//      a synchronous dispose() in the effect cleanup would make the children
//      re-subscribe to DETACHED state cells, and a detached cell throws
//      DashboardError('disposed') — @testing-library flushes passive effects inside
//      act(), so that throw would fail this test directly.
import { StrictMode } from 'react';
import type { DashboardPlugin } from '@underload/dashboard';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as dashboardBarrel from './index';
import {
    ASIDE_SLOT,
    LAYOUT_ASIDE_PLACEHOLDER,
    LAYOUT_SIDEBAR_PLACEHOLDER,
    LAYOUT_STAGE_PLACEHOLDER,
    SIDEBAR_SLOT,
    STAGE_SLOT,
    UI_DENSITY_STATE,
    UI_MOTION_STATE,
    UI_THEME_STATE,
    type DashboardDensity,
    type DashboardMotion,
    type DashboardTheme,
    type PanelValue
} from './contract';
import { createChatDashboard } from './composition';
import { ChatAssistantApp } from './ChatAssistantApp';
import { WorkstationShell } from './WorkstationShell';
import { TEST_BASE_URL, TEST_PROVIDER_URL } from './plugins/harness';

afterEach(() => {
    cleanup();
});

/**
 * A feature plugin the shell has never heard of: proves feature-blindness. Both
 * orders are ABOVE the real surfaces (40 sidebar / 50 stage / 60 inspector) because
 * the rule under test is "the highest order wins", not "the last registration wins".
 */
const StageProbe = () => <p data-testid="probe-stage">probe stage</p>;

const probePlugin: DashboardPlugin = {
    id: 'probe',
    setup(api) {
        api.slot<PanelValue>(STAGE_SLOT, { id: 'probe.stage', order: 70, value: { component: StageProbe } });
        // A DESCRIPTOR contribution (title + body) in another channel: the shell must
        // still render panel chrome around it, which the component-form owners above
        // (the three real surfaces) deliberately do not get.
        api.slot<PanelValue>(ASIDE_SLOT, {
            id: 'probe.aside',
            order: 80,
            value: { title: 'Probe inspector', body: 'probe aside body' }
        });
    }
};

describe('contract ids (the keystone downstream tasks write against)', () => {
    // Every id the rebuild was specified with, verbatim. A subset check on
    // PURPOSE: a later task may add ids, but nobody may rename or drop one of
    // these, because the sidebar/transcript/composer/agents tasks hardcode them.
    const REQUIRED_IDS: readonly string[] = [
        // state
        'chat.mode', 'chat.providerBase', 'chat.sessions', 'chat.activeSessionId', 'chat.transcript',
        'chat.status', 'chat.error', 'chat.draft', 'chat.model', 'chat.agent', 'chat.models',
        'chat.systemDraft', 'chat.editingSystem', 'chat.collapsedTurns', 'chat.agents', 'chat.tools',
        'chat.activeAgentId', 'chat.activeToolId', 'chat.usage', 'chat.pending', 'chat.streaming',
        'chat.listening', 'chat.autoscroll', 'chat.sidebarTab', 'chat.drawerOpen', 'chat.turns',
        'ui.theme', 'ui.density', 'ui.motion',
        // commands
        'chat.session.create', 'chat.session.select', 'chat.session.delete', 'chat.session.rename',
        'chat.message.send', 'chat.message.cancel', 'chat.message.copy', 'chat.message.fork',
        'chat.message.role', 'chat.message.delete', 'chat.message.update', 'chat.turn.toggle',
        'chat.system.begin', 'chat.system.save', 'chat.system.cancel', 'chat.draft.set',
        'chat.model.set', 'chat.agent.set', 'chat.agent.create', 'chat.agent.save', 'chat.agent.delete',
        'chat.tool.create', 'chat.tool.save', 'chat.tool.delete', 'chat.voice.start', 'chat.voice.stop',
        'chat.mode.set', 'chat.providerBase.set', 'chat.autoscroll.toggle', 'chat.composer.focus',
        // services
        'chat.conversations', 'chat.provider', 'chat.speech', 'chat.agentStore', 'chat.toolStore',
        // events
        'chat.session.created', 'chat.session.selected', 'chat.error', 'chat.notice',
        'chat.stream.started', 'chat.stream.delta', 'chat.stream.completed', 'chat.stream.cancelled',
        'chat.transcript.updated',
        // slots
        'layout.sidebar', 'layout.stage', 'layout.aside'
    ];

    it('exports every specified id as a string constant through the barrel', () => {
        // The barrel's string exports infer as literal unions, so the filter has
        // no usable type predicate here; the cast to string[] is the widening.
        const values: readonly unknown[] = Object.values(dashboardBarrel);
        const exported = new Set<string>(values.filter((value) => typeof value === 'string') as string[]);
        // [] on success: the diff names exactly the missing ids.
        expect(REQUIRED_IDS.filter((id) => !exported.has(id))).toEqual([]);
    });
});

describe('createChatDashboard (composition)', () => {
    it('schedules the complete final graph: skin, chat set, then the add-ons', () => {
        // The framework's deterministic schedule. `requires: ['chat.core']` is what
        // puts the chat core first among the chat plugins and every add-on after it;
        // the chat set's internal order is the schedule's, not the array's (source
        // before sessions), which is exactly why composition.ts documents `requires`
        // as the ordering mechanism. `chat.surfaces` LAST is the load-bearing fact
        // for the region channels: the shell renders a channel's final contribution,
        // so the real surfaces must be the last claimers (see the invariant list
        // below, which is what this test actually guarantees).
        const instance = createChatDashboard();
        expect(instance.plugins).toEqual([
            'layout',
            'theme',
            'chat.core',
            'chat.source',
            'chat.sessions',
            'chat.transcript',
            'chat.system-prompt',
            'chat.agents',
            'chat.tools',
            'chat.settings',
            'chat.voice',
            'chat.notices',
            'chat.inputs',
            'chat.surfaces'
        ]);
        // The orderings that matter, asserted as invariants so a reorder that keeps
        // them passes and one that breaks them fails with a readable diff:
        const order = (id: string) => (instance.plugins as string[]).indexOf(id);
        expect(order('layout')).toBe(0);
        expect(order('theme')).toBe(1);
        expect(order('chat.core')).toBeLessThan(order('chat.source'));
        expect(order('chat.core')).toBeLessThan(order('chat.surfaces'));
        // The event observer of the whole graph runs last-but-one, and the visible
        // surfaces run last.
        expect(order('chat.surfaces')).toBe(instance.plugins.length - 1);
        expect(order('chat.notices')).toBeGreaterThan(order('chat.source'));
        expect(instance.disposed).toBe(false);
        instance.dispose();
        expect(instance.disposed).toBe(true);
    });

    it('defaults the skin to ink/comfortable/full when matchMedia is absent', () => {
        // jsdom has no window.matchMedia: every prefers() probe must fall back to
        // "no preference", which resolves to the documented dark default.
        const instance = createChatDashboard();
        expect(instance.state<DashboardTheme>(UI_THEME_STATE).get()).toBe('ink');
        expect(instance.state<DashboardDensity>(UI_DENSITY_STATE).get()).toBe('comfortable');
        expect(instance.state<DashboardMotion>(UI_MOTION_STATE).get()).toBe('full');
        instance.dispose();
    });

    it('contributes the layout fallback plus the real owner for every region channel', () => {
        // T6: the core's 10/20/30 placeholders are gone (components/Placeholder*.tsx
        // deleted), so each channel is exactly the order-0 descriptor plus its owner
        // in the 40/50/60 band. Never two contributions at the SAME order inside one
        // channel — the shell would keep only the later registration.
        const instance = createChatDashboard();
        expect(instance.slot<PanelValue>(SIDEBAR_SLOT).map((c) => [c.id, c.order])).toEqual([
            [LAYOUT_SIDEBAR_PLACEHOLDER, 0],
            ['chat.sidebar', 40]
        ]);
        expect(instance.slot<PanelValue>(STAGE_SLOT).map((c) => [c.id, c.order])).toEqual([
            [LAYOUT_STAGE_PLACEHOLDER, 0],
            ['chat.stage', 50]
        ]);
        expect(instance.slot<PanelValue>(ASIDE_SLOT).map((c) => [c.id, c.order])).toEqual([
            [LAYOUT_ASIDE_PLACEHOLDER, 0],
            ['chat.inspector', 60]
        ]);
        instance.dispose();
    });

    it('registers the two composer input commands the views execute', () => {
        // The gap this closes: ComposerDeck.tsx:127 and ModelPicker.tsx:248 execute
        // these ids, and an unregistered id throws `unknown-command` at click time.
        const instance = createChatDashboard();
        expect(() => instance.execute<string, void>('chat.draft.set', 'typed text')).not.toThrow();
        expect(instance.state<string>('chat.draft').get()).toBe('typed text');
        expect(() => instance.execute<string, void>('chat.model.set', 'alpha/flash')).not.toThrow();
        expect(instance.state<string>('chat.model').get()).toBe('alpha/flash');
        instance.dispose();
    });

    it('validates the skin commands instead of accepting any string', () => {
        const instance = createChatDashboard();
        expect(instance.execute<DashboardTheme, DashboardTheme>('ui.theme.set', 'slate')).toBe('slate');
        expect(() => instance.execute<DashboardTheme, DashboardTheme>('ui.theme.set', 'neon' as DashboardTheme)).toThrow(
            'Unknown ui theme: neon'
        );
        expect(instance.execute<void, DashboardTheme>('ui.theme.toggle')).toBe('ink');
        expect(instance.execute<DashboardDensity, DashboardDensity>('ui.density.set', 'compact')).toBe('compact');
        expect(() => instance.execute<DashboardDensity, DashboardDensity>('ui.density.set', 'tiny' as DashboardDensity)).toThrow(
            'Unknown ui density: tiny'
        );
        instance.dispose();
    });
});

describe('WorkstationShell', () => {
    it('renders the station root, the skin attributes and the three regions', () => {
        const instance = createChatDashboard();
        const { container } = render(<WorkstationShell instance={instance} />);

        const root = screen.getByTestId('station-root');
        expect(root.className).toBe('station');
        expect(root.getAttribute('data-theme')).toBe('ink');
        expect(root.getAttribute('data-density')).toBe('comfortable');
        expect(root.getAttribute('data-motion')).toBe('full');

        expect(container.querySelectorAll('.station__region')).toHaveLength(3);
        expect(screen.getByTestId('region-sidebar').getAttribute('data-region')).toBe('sidebar');
        expect(screen.getByTestId('region-stage').getAttribute('data-region')).toBe('stage');
        expect(screen.getByTestId('region-aside').getAttribute('data-region')).toBe('aside');

        // T6: the channels belong to the REAL surfaces, in component form, which the
        // shell renders with NO panel chrome (the descriptor path is covered by the
        // probe plugin below).
        expect(screen.getByTestId('region-sidebar').querySelector('[data-testid="sidebar"]')).not.toBeNull();
        expect(screen.getByTestId('region-stage').querySelector('[data-testid="stage"]')).not.toBeNull();
        expect(screen.getByTestId('region-aside').querySelector('[data-testid="aside-panel"]')).not.toBeNull();
        expect(screen.getByTestId('station-bar').textContent).toContain('Chat Assistant');

        instance.dispose();
    });

    it('lets a later contribution replace a region and leaves the others alone', () => {
        const instance = createChatDashboard({ extraPlugins: [probePlugin] });
        render(<WorkstationShell instance={instance} />);

        expect(screen.getByTestId('probe-stage').textContent).toBe('probe stage');
        // Winner-takes-region: order 70 beat the real stage owner at 50...
        expect(screen.queryByTestId('stage')).toBeNull();
        // ...but only in the channels that were contributed to. The rail keeps its
        // owner (nothing touched that channel), and the aside's descriptor probe
        // renders inside the shell's panel chrome.
        expect(
            screen.getByTestId('region-sidebar').querySelector('[data-testid="sidebar"]')
        ).not.toBeNull();
        expect(screen.getByTestId('region-aside').querySelector('.panel__title')?.textContent).toBe(
            'Probe inspector'
        );
        expect(screen.getByTestId('region-aside').querySelector('[data-testid="aside-panel"]')).toBeNull();

        instance.dispose();
    });

    it('switches the skin through the ui.theme.toggle command', () => {
        const instance = createChatDashboard();
        render(<WorkstationShell instance={instance} />);

        expect(instance.state<DashboardTheme>(UI_THEME_STATE).get()).toBe('ink');
        act(() => {
            screen.getByTestId('theme-toggle').click();
        });

        expect(instance.state<DashboardTheme>(UI_THEME_STATE).get()).toBe('slate');
        expect(screen.getByTestId('station-root').getAttribute('data-theme')).toBe('slate');
        expect(screen.getByTestId('theme-toggle').textContent).toBe('Slate');

        instance.dispose();
    });
});

describe('ChatAssistantApp', () => {
    it('mounts and unmounts under StrictMode without touching a disposed cell', async () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const view = render(
            <StrictMode>
                {/* The full-endpoint form (harness.ts:33, :35): the props keep their
                    pre-rebuild meaning, and a bare origin here would repoint the
                    conversation routes at the storage root. */}
                <ChatAssistantApp baseUrl={TEST_BASE_URL} providerUrl={TEST_PROVIDER_URL} />
            </StrictMode>
        );

        // One instance per mount, and it survives StrictMode's double effect pass.
        expect(document.querySelectorAll('[data-testid="station-root"]')).toHaveLength(1);
        expect(document.querySelectorAll('.station__region')).toHaveLength(3);

        view.unmount();
        // The deferred dispose() runs on the microtask after the unmount pass.
        await act(async () => {
            await Promise.resolve();
        });

        expect(errors.mock.calls.map((call) => call.map(String).join(' '))).toEqual([]);
        errors.mockRestore();
    });
});
