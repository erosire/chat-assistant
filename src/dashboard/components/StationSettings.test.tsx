// StationSettings: the configuration surface's render and dispatch contract.
//
// The oracle's settings panel (src/components/ChatAssistantApp.tsx:4808-4871) is the
// source of every string asserted here, and the assertions are exact: option VALUES
// and LABELS, the note copy, the placeholder, and the offline-only field rules.
//
// Two things are pinned beyond the copy:
//   1. EVERY mutation goes through a command (`chat.mode.set`, `chat.providerBase.set`,
//      `ui.*.set`) and never through a cell write — the harness publishes the value
//      into the cell the way the real plugins do, so the follow-up render proves the
//      control is driven by state rather than by its own DOM value.
//   2. The provider base keeps the RAW typed value in the cell (fluid typing, oracle
//      3360-3362) while the command owns normalization and persistence.
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
    CHAT_MODE_STATE,
    CHAT_PROVIDER_BASE_STATE,
    UI_DENSITY_STATE,
    UI_MOTION_STATE,
    UI_THEME_STATE,
    type ChatMode,
    type DashboardDensity,
    type DashboardMotion,
    type DashboardTheme
} from '../contract';
import { StationSettings } from './StationSettings';
import { renderWithHarness, type HarnessSeed } from './test-harness';

afterEach(() => {
    cleanup();
});

const ONLINE: HarnessSeed = { mode: 'online', providerBase: '' };
const OFFLINE_BLANK: HarnessSeed = { mode: 'offline', providerBase: '' };
const OFFLINE_SET: HarnessSeed = {
    mode: 'offline',
    providerBase: 'http://192.168.50.109:5500/providers/private/v1'
};

describe('the mode selector', () => {
    it('renders the oracle\'s two options with their exact values and labels', () => {
        renderWithHarness(<StationSettings />, ONLINE);
        const select = screen.getByTestId('mode-select') as HTMLSelectElement;

        expect(Array.from(select.options).map((option) => [option.value, option.text])).toEqual([
            ['online', 'Online (application servers)'],
            ['offline', 'Offline (no application server)']
        ]);
        expect(select.value).toBe('online');
        expect(select.getAttribute('aria-label')).toBe('Assistant mode');
        // The <label> wrapper is the field: caption + control, oracle 4818-4829.
        const field = screen.getByTestId('mode-field');
        expect(field.tagName).toBe('LABEL');
        expect(within(field).getByText('Mode').textContent).toBe('Mode');
        expect(within(field).getByTestId('mode-select')).toBeTruthy();
    });

    it('keeps the scope note visible in BOTH modes (R6)', () => {
        for (const seed of [ONLINE, OFFLINE_BLANK]) {
            const { unmount } = renderWithHarness(<StationSettings />, seed);
            expect(screen.getByTestId('mode-note').textContent).toBe(
                'Offline is a no-Chat-Assistant-server mode: conversations are stored in this browser and NO requests are made to the application storage server or the private provider relay. The model endpoints below are still remote OpenAI-compatible inference services — they require network connectivity and CORS from this browser (this is not a network-free local model, and no service worker, bundled browser model, or local tool execution is provided).'
            );
            unmount();
        }
    });

    it('switching the mode dispatches chat.mode.set and the offline field appears', () => {
        const view = renderWithHarness(<StationSettings />, ONLINE);
        expect(screen.queryByTestId('provider-base-field')).toBeNull();

        fireEvent.change(screen.getByTestId('mode-select'), { target: { value: 'offline' } });

        // One dispatch with the coerced mode, and the cell — not the DOM — decides what
        // renders next.
        expect(view.callsOf('chat.mode.set')).toEqual(['offline']);
        expect(view.read<ChatMode>(CHAT_MODE_STATE)).toBe('offline');
        expect(screen.getByTestId('provider-base-field')).toBeTruthy();
        expect((screen.getByTestId('mode-select') as HTMLSelectElement).value).toBe('offline');
    });

    it('coerces any other value to online, the way switchMode does', () => {
        const view = renderWithHarness(<StationSettings />, OFFLINE_BLANK);

        fireEvent.change(screen.getByTestId('mode-select'), { target: { value: 'nonsense' } });

        expect(view.callsOf('chat.mode.set')).toEqual(['online']);
    });
});

describe('the offline provider base', () => {
    it('is absent while the app is online, so a field the transport ignores is never offered', () => {
        renderWithHarness(<StationSettings />, { ...ONLINE, providerBase: 'http://ignored.test/v1' });

        expect(screen.queryByTestId('provider-base-field')).toBeNull();
        expect(screen.queryByTestId('provider-base-input')).toBeNull();
        expect(screen.queryByTestId('offline-endpoint-hint')).toBeNull();
    });

    it('names both derived routes in its label and the placeholder, and asks for a base when blank', () => {
        const view = renderWithHarness(<StationSettings />, OFFLINE_BLANK);
        const field = screen.getByTestId('provider-base-field');
        const input = screen.getByTestId('provider-base-input') as HTMLInputElement;

        expect(within(field).getByText(/Provider base URL/).textContent).toBe(
            'Provider base URL (models /models · stream /chat/completions)'
        );
        expect(input.value).toBe('');
        expect(input.placeholder).toBe('http://192.168.50.109:5500/providers/private/v1');
        expect(input.getAttribute('aria-label')).toBe('Offline provider base URL');
        expect(screen.getByTestId('offline-endpoint-hint').textContent).toBe(
            'Set the provider base URL to load the model catalog from its /models route and stream replies from /chat/completions (for example, http://192.168.50.109:5500/providers/private/v1). While it is blank, no request is sent to the default app server.'
        );
        expect(view.read<string>(CHAT_PROVIDER_BASE_STATE)).toBe('');
    });

    it('stops nagging once the base is configured', () => {
        renderWithHarness(<StationSettings />, OFFLINE_SET);

        expect((screen.getByTestId('provider-base-input') as HTMLInputElement).value).toBe(
            'http://192.168.50.109:5500/providers/private/v1'
        );
        expect(screen.queryByTestId('offline-endpoint-hint')).toBeNull();
    });

    it('dispatches the RAW typed value, mid-edit included, with no trimming', () => {
        const view = renderWithHarness(<StationSettings />, OFFLINE_BLANK);
        const input = screen.getByTestId('provider-base-input');

        fireEvent.change(input, { target: { value: 'http:' } });
        expect(view.callsOf('chat.providerBase.set')).toEqual(['http:']);

        fireEvent.change(input, { target: { value: ' http://lan.test/v1/ ' } });

        // Half a URL is still what the operator typed: the command persists the
        // canonical form, the cell keeps the raw one.
        expect(view.callsOf('chat.providerBase.set')).toEqual(['http:', ' http://lan.test/v1/ ']);
        expect(view.read<string>(CHAT_PROVIDER_BASE_STATE)).toBe(' http://lan.test/v1/ ');
        expect((screen.getByTestId('provider-base-input') as HTMLInputElement).value).toBe(
            ' http://lan.test/v1/ '
        );
    });
});

describe('the skin switches', () => {
    it('marks the live value of each group as pressed, and only that one', () => {
        renderWithHarness(<StationSettings />, { ...ONLINE, theme: 'slate', density: 'compact' });

        const pressed = (testId: string): boolean =>
            screen.getByTestId(testId).getAttribute('aria-pressed') === 'true';

        expect(pressed('settings-theme-ink')).toBe(false);
        expect(pressed('settings-theme-slate')).toBe(true);
        expect(pressed('settings-density-comfortable')).toBe(false);
        expect(pressed('settings-density-compact')).toBe(true);
        expect(pressed('settings-motion-full')).toBe(true);
        expect(pressed('settings-motion-reduced')).toBe(false);
        // Each set is one accessible group, so a screen reader announces the pair
        // together instead of six unrelated buttons.
        expect(screen.getByTestId('settings-theme-group').getAttribute('aria-label')).toBe('Theme');
        expect(screen.getByTestId('settings-density-group').getAttribute('aria-label')).toBe('Spacing');
        expect(screen.getByTestId('settings-motion-group').getAttribute('aria-label')).toBe('Motion');
    });

    it('states the value each control WOULD set, and dispatches it', () => {
        const view = renderWithHarness(<StationSettings />, ONLINE);

        fireEvent.click(screen.getByTestId('settings-theme-slate'));
        fireEvent.click(screen.getByTestId('settings-density-compact'));
        fireEvent.click(screen.getByTestId('settings-motion-reduced'));

        expect(view.callsOf('ui.theme.set')).toEqual(['slate']);
        expect(view.callsOf('ui.density.set')).toEqual(['compact']);
        expect(view.callsOf('ui.motion.set')).toEqual(['reduced']);
        // The pressed state follows the CELL, which is what the shell projects onto
        // `.station[data-*]`.
        expect(view.read<DashboardTheme>(UI_THEME_STATE)).toBe('slate');
        expect(view.read<DashboardDensity>(UI_DENSITY_STATE)).toBe('compact');
        expect(view.read<DashboardMotion>(UI_MOTION_STATE)).toBe('reduced');
        expect(screen.getByTestId('settings-theme-slate').getAttribute('aria-pressed')).toBe('true');
    });

    it('re-arms its own control from a change made anywhere else in the graph', () => {
        const view = renderWithHarness(<StationSettings />, ONLINE);

        act(() => view.write<DashboardMotion>(UI_MOTION_STATE, 'reduced'));

        expect(screen.getByTestId('settings-motion-reduced').getAttribute('aria-pressed')).toBe(
            'true'
        );
        expect(screen.getByTestId('settings-motion-full').getAttribute('aria-pressed')).toBe('false');
        // No command ran for an external write: the panel follows state, it does not
        // echo its own clicks.
        expect(view.callsOf('ui.motion.set')).toEqual([]);
    });
});

describe('the palette swatches', () => {
    it('prints the active theme\'s token set in a fixed order', () => {
        const view = renderWithHarness(<StationSettings />, { ...ONLINE, theme: 'slate' });
        const list = screen.getByTestId('settings-palette');

        expect(list.getAttribute('aria-label')).toBe('slate palette');
        const rows = within(list).getAllByRole('listitem');
        expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
            'swatch-surface',
            'swatch-raised',
            'swatch-line',
            'swatch-text',
            'swatch-muted',
            'swatch-accent',
            'swatch-warn'
        ]);
        // The chip is CSS-tinted (background: var(--token)) and the row prints the
        // REFERENCE, never a duplicated hex value.
        expect(rows[0].querySelector('.swatches__chip')?.getAttribute('data-token')).toBe('surface');
        expect(rows[0].querySelector('.swatches__chip')?.getAttribute('aria-hidden')).toBe('true');
        expect(rows[0].querySelector('.swatches__name')?.textContent).toBe('surface');
        expect(rows[0].querySelector('.swatches__value')?.textContent).toBe('var(--surface)');
        // The palette name follows the cell, so the panel cannot disagree with the
        // theme the shell is rendering.
        act(() => view.write<DashboardTheme>(UI_THEME_STATE, 'ink'));
        expect(screen.getByTestId('settings-palette').getAttribute('aria-label')).toBe('ink palette');
    });
});

describe('the surface itself', () => {
    it('owns one workspace root, a heading, and never borrows another surface\'s testid', () => {
        renderWithHarness(<StationSettings />, OFFLINE_BLANK);

        const workspace = screen.getByTestId('settings-workspace');
        expect(workspace.tagName).toBe('SECTION');
        expect(workspace.className).toBe('settings');
        expect(screen.getByTestId('settings-heading').textContent).toBe('Settings');
        // The strip/banner testids belong to NoticeStrip.tsx and ChatStage.tsx, and
        // this surface uses neither.
        expect(screen.queryByTestId('notice-strip')).toBeNull();
        expect(screen.queryByTestId('error-banner')).toBeNull();
    });
});
