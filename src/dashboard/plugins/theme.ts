// Theme plugin: operator skin preferences, as three independent state cells the
// shell projects onto `data-*` attributes on the station root. Vendored and
// adapted from packages/underload/dashboard/example/src/plugins/theme.ts.
//
// Three separate cells (mode / density / motion) so a consumer can honour one
// without the others. The stylesheet does everything else: styles/tokens.css
// keys every colour and metric off `.station[data-theme|data-density|data-motion]`,
// so this plugin owns no colour value at all (the palette is not duplicated here
// the way the example duplicates it for its swatch panel).
import type { DashboardPlugin, DashboardState } from '@underload/dashboard';
import {
    PLUGIN_IDS,
    UI_DENSITY_SET_COMMAND,
    UI_DENSITY_STATE,
    UI_MOTION_SET_COMMAND,
    UI_MOTION_STATE,
    UI_THEME_CHANGED_EVENT,
    UI_THEME_SET_COMMAND,
    UI_THEME_STATE,
    UI_THEME_TOGGLE_COMMAND,
    type DashboardDensity,
    type DashboardMotion,
    type DashboardTheme
} from '../contract';

// The accepted value sets, declared as data so the runtime guards below and any
// settings UI stay in sync (the TS unions are the compile-time half).
const THEMES: readonly DashboardTheme[] = ['ink', 'slate'];
const DENSITIES: readonly DashboardDensity[] = ['comfortable', 'compact'];
const MOTIONS: readonly DashboardMotion[] = ['full', 'reduced'];

/**
 * Media query probe with the fallbacks the host environment needs.
 *
 * Setup runs during a React render in the browser, but the same composition runs
 * under jsdom (vitest) and could run in Node during a test, where `matchMedia`
 * is missing entirely, and jsdom's own stub can throw. All three cases must
 * degrade to "no preference" rather than fail the whole build, because a plugin
 * that throws during setup() discards the dashboard (`setup-failed`).
 */
const prefers = (query: string): boolean => {
    try {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
            return false;
        }
        return window.matchMedia(query).matches === true;
    } catch {
        return false;
    }
};

/**
 * 'ink' (dark) is the default skin. Only an explicit LIGHT preference flips it,
 * so an environment with no media support — jsdom, a test, a headless render —
 * still resolves to the documented default instead of the light theme.
 */
const readInitialTheme = (): DashboardTheme =>
    prefers('(prefers-color-scheme: light)') ? 'slate' : 'ink';

// Density has no OS signal, so the comfortable band is always the starting point.
const readInitialDensity = (): DashboardDensity => 'comfortable';

// An OS-level reduced-motion preference is honoured as the initial value; the
// operator can still override it, and base.css also repeats the honour in CSS so
// the media preference wins even when the cell says 'full'.
const readInitialMotion = (): DashboardMotion =>
    prefers('(prefers-reduced-motion: reduce)') ? 'reduced' : 'full';

export function createThemePlugin(): DashboardPlugin {
    return {
        id: PLUGIN_IDS.theme,
        setup(api) {
            const theme: DashboardState<DashboardTheme> = api.state<DashboardTheme>(
                UI_THEME_STATE,
                readInitialTheme()
            );
            const density: DashboardState<DashboardDensity> = api.state<DashboardDensity>(
                UI_DENSITY_STATE,
                readInitialDensity()
            );
            const motion: DashboardState<DashboardMotion> = api.state<DashboardMotion>(
                UI_MOTION_STATE,
                readInitialMotion()
            );

            api.command<DashboardTheme, DashboardTheme>(UI_THEME_SET_COMMAND, (next) => {
                // Commands are reachable through instance.execute(), i.e. from
                // untyped callers too, so every accepted value is validated here.
                if (!THEMES.includes(next)) {
                    throw new Error(`Unknown ui theme: ${String(next)}`);
                }
                // SameValueZero makes an equal write a no-op for state; the event
                // is suppressed on that no-op so listeners never see a fake change.
                const changed = theme.get() !== next;
                theme.set(next);
                if (changed) {
                    api.emit<DashboardTheme>(UI_THEME_CHANGED_EVENT, next);
                }
                return theme.get();
            });

            api.command<void, DashboardTheme>(UI_THEME_TOGGLE_COMMAND, () => {
                const next: DashboardTheme = theme.get() === 'ink' ? 'slate' : 'ink';
                theme.set(next);
                api.emit<DashboardTheme>(UI_THEME_CHANGED_EVENT, next);
                return next;
            });

            api.command<DashboardDensity, DashboardDensity>(UI_DENSITY_SET_COMMAND, (next) => {
                if (!DENSITIES.includes(next)) {
                    throw new Error(`Unknown ui density: ${String(next)}`);
                }
                density.set(next);
                return next;
            });

            api.command<DashboardMotion, DashboardMotion>(UI_MOTION_SET_COMMAND, (next) => {
                if (!MOTIONS.includes(next)) {
                    throw new Error(`Unknown ui motion: ${String(next)}`);
                }
                motion.set(next);
                return next;
            });
        }
    };
}
