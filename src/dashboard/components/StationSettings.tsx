// StationSettings — the configuration surface: assistant mode, the offline provider
// base, and the three skin switches with their live palette.
//
// BEHAVIOR ORACLE (read-only): src/components/ChatAssistantApp.tsx
//   - the settings workspace render            4808-4871
//   - mode selector + its exact option copy    4818-4829
//   - the R6 scope note                        4837-4839
//   - offline-only provider base field         4849-4858
//   - the blank-base guidance note             4863-4867
//   - `switchMode` / `updateProviderBase`      3387-3427
// The skin half has no oracle counterpart (the pre-rebuild app had no theme switch):
// it follows the vendored reference panel
// (packages/underload/dashboard/example/src/components/StationSettings.tsx) in idiom,
// adapted to this distribution's ids and to a palette that lives in CSS custom
// properties rather than in a `theme.palettes` service.
//
// EVERY MUTATION IS A COMMAND, never a cell write: `chat.mode.set` owns the persist +
// namespace reset (plugins/settings.ts) and `chat.providerBase.set` owns the persist +
// stream invalidation, so a view that wrote `chat.mode` directly would switch modes
// without re-persisting them and without clearing the previous namespace. The ui.*
// commands validate their input and emit `ui.theme.changed`
// (plugins/theme.ts:86-123), which is what the shell's repaint hosts listen for.
//
// WHY THE PROVIDER FIELD IS OFFLINE-ONLY (oracle 4847): in online mode the provider
// base is deployment configuration (composition.ts's `providerUrl`), not operator
// configuration — rendering it while online would offer a field the transport ignores.
// The R6 note stays visible in BOTH modes so the scope claim is never hidden behind a
// selection, which is what the oracle does with its unconditional `mode-note`.
//
// THE SWATCHES: the palette is `styles/tokens.css`, keyed off
// `.station[data-theme]`, so the chip is tinted by CSS (`background: var(--token)`)
// and the row prints the TOKEN NAME rather than a hex value. Duplicating the hex
// values in JS — as the example does for its `theme.palettes` service — would put a
// second copy of the palette in the app and let the two drift.
import {
    CHAT_MODE_SET_COMMAND,
    CHAT_MODE_STATE,
    CHAT_PROVIDER_BASE_SET_COMMAND,
    CHAT_PROVIDER_BASE_STATE,
    UI_DENSITY_SET_COMMAND,
    UI_DENSITY_STATE,
    UI_MOTION_SET_COMMAND,
    UI_MOTION_STATE,
    UI_THEME_SET_COMMAND,
    UI_THEME_STATE,
    type ChatMode,
    type DashboardDensity,
    type DashboardMotion,
    type DashboardTheme
} from '../contract';
import { useDashboardValue } from '../state-hooks';
import { useWorkbench } from '../workbench';
import {
    SettingsField,
    SettingsGroup,
    SettingsInput,
    SettingsNote,
    SettingsOption,
    SettingsSelect,
    SettingsWorkspace,
    type SettingsChoice
} from './SettingsPanel';

// ——— the copy, verbatim from the oracle (parity assertions match these) ——————————

export const MODE_CHOICES: readonly SettingsChoice[] = Object.freeze([
    { value: 'online', label: 'Online (application servers)' },
    { value: 'offline', label: 'Offline (no application server)' }
]);

/** R6: offline drops the app SERVER, not the network (oracle 4837-4839). */
export const MODE_NOTE =
    'Offline is a no-Chat-Assistant-server mode: conversations are stored in this browser and NO requests are made to the application storage server or the private provider relay. The model endpoints below are still remote OpenAI-compatible inference services — they require network connectivity and CORS from this browser (this is not a network-free local model, and no service worker, bundled browser model, or local tool execution is provided).';

/** One base, two derived routes — the field label names both so the value reads unambiguously. */
export const PROVIDER_BASE_LABEL =
    'Provider base URL (models /models · stream /chat/completions)';

export const PROVIDER_BASE_PLACEHOLDER = 'http://192.168.50.109:5500/providers/private/v1';

/** The blank-base explanation (oracle 4863-4867): a blank base never hits the default server. */
export const OFFLINE_ENDPOINT_HINT =
    'Set the provider base URL to load the model catalog from its /models route and stream replies from /chat/completions (for example, http://192.168.50.109:5500/providers/private/v1). While it is blank, no request is sent to the default app server.';

// ——— the skin vocabulary, mirroring plugins/theme.ts's accepted value sets ————————

const THEMES: readonly { value: DashboardTheme; label: string }[] = Object.freeze([
    { value: 'ink', label: 'Ink' },
    { value: 'slate', label: 'Slate' }
]);

const DENSITIES: readonly { value: DashboardDensity; label: string }[] = Object.freeze([
    { value: 'comfortable', label: 'Comfortable' },
    { value: 'compact', label: 'Compact' }
]);

const MOTIONS: readonly { value: DashboardMotion; label: string }[] = Object.freeze([
    { value: 'full', label: 'Full motion' },
    { value: 'reduced', label: 'Reduced motion' }
]);

/**
 * The tokens the swatch panel prints, in reading order (the example's `PALETTE_KEYS`,
 * workstation.css:30-38). Order is fixed so the rendered palette is assertable, and
 * every name here MUST exist in styles/tokens.css — a typo would show an unpainted
 * chip rather than throw.
 */
export const SWATCH_TOKENS: readonly string[] = Object.freeze([
    'surface',
    'raised',
    'line',
    'text',
    'muted',
    'accent',
    'warn'
]);

export function StationSettings() {
    const instance = useWorkbench();
    const mode = useDashboardValue<ChatMode>(CHAT_MODE_STATE);
    const providerBase = useDashboardValue<string>(CHAT_PROVIDER_BASE_STATE);
    const theme = useDashboardValue<DashboardTheme>(UI_THEME_STATE);
    const density = useDashboardValue<DashboardDensity>(UI_DENSITY_STATE);
    const motion = useDashboardValue<DashboardMotion>(UI_MOTION_STATE);

    const offline = mode === 'offline';

    return (
        <SettingsWorkspace heading="Settings">
            {/* The MODE selector (oracle 4818-4829). Anything other than 'offline' is
                coerced to 'online', the same guard switchMode applies (:3395). */}
            <SettingsField label="Mode" testId="mode-field">
                <SettingsSelect
                    testId="mode-select"
                    ariaLabel="Assistant mode"
                    value={mode}
                    options={MODE_CHOICES}
                    onChange={(value) =>
                        instance.execute<ChatMode>(
                            CHAT_MODE_SET_COMMAND,
                            value === 'offline' ? 'offline' : 'online'
                        )
                    }
                />
            </SettingsField>

            <SettingsNote testId="mode-note">{MODE_NOTE}</SettingsNote>

            {/* The offline-only configuration: ONE base URL, because the standard
                OpenAI-compatible routes derive beneath it (api/offline.ts:50-68). */}
            {offline ? (
                <>
                    <SettingsField label={PROVIDER_BASE_LABEL} testId="provider-base-field">
                        <SettingsInput
                            testId="provider-base-input"
                            ariaLabel="Offline provider base URL"
                            placeholder={PROVIDER_BASE_PLACEHOLDER}
                            // The RAW value goes into the cell (fluid typing, oracle
                            // 3360-3362); `chat.providerBase.set` normalizes what it
                            // persists and refreshes the catalog for the new base.
                            value={providerBase}
                            onChange={(value) =>
                                instance.execute<string>(CHAT_PROVIDER_BASE_SET_COMMAND, value)
                            }
                        />
                    </SettingsField>
                    {/* Shown only while the base is unconfigured, so a configured
                        station is not nagged about the field it already filled. */}
                    {providerBase.trim() === '' ? (
                        <SettingsNote testId="offline-endpoint-hint">
                            {OFFLINE_ENDPOINT_HINT}
                        </SettingsNote>
                    ) : null}
                </>
            ) : null}

            {/* ——— the skin switches ——————————————————————————————————————————————
                Three independent groups: theme, spacing and motion are separate cells
                (plugins/theme.ts:73-84) so a consumer can honour one without the
                others, and each button states the value it WOULD set rather than
                toggling, which keeps the pressed state honest. */}
            <SettingsGroup label="Theme" testId="settings-theme-group">
                {THEMES.map((entry) => (
                    <SettingsOption
                        key={entry.value}
                        testId={`settings-theme-${entry.value}`}
                        label={entry.label}
                        active={theme === entry.value}
                        onSelect={() =>
                            instance.execute<DashboardTheme>(UI_THEME_SET_COMMAND, entry.value)
                        }
                    />
                ))}
            </SettingsGroup>

            <SettingsGroup label="Spacing" testId="settings-density-group">
                {DENSITIES.map((entry) => (
                    <SettingsOption
                        key={entry.value}
                        testId={`settings-density-${entry.value}`}
                        label={entry.label}
                        active={density === entry.value}
                        onSelect={() =>
                            instance.execute<DashboardDensity>(UI_DENSITY_SET_COMMAND, entry.value)
                        }
                    />
                ))}
            </SettingsGroup>

            <SettingsGroup label="Motion" testId="settings-motion-group">
                {MOTIONS.map((entry) => (
                    <SettingsOption
                        key={entry.value}
                        testId={`settings-motion-${entry.value}`}
                        label={entry.label}
                        active={motion === entry.value}
                        onSelect={() =>
                            instance.execute<DashboardMotion>(UI_MOTION_SET_COMMAND, entry.value)
                        }
                    />
                ))}
            </SettingsGroup>

            {/* The live palette of the ACTIVE theme: the chip reads `var(--token)` off
                `.station[data-theme]`, so switching themes repaints this list with no
                JS. The accessible name names which palette is on screen. */}
            <ul className="swatches" data-testid="settings-palette" aria-label={`${theme} palette`}>
                {SWATCH_TOKENS.map((token) => (
                    <li className="swatches__row" key={token} data-testid={`swatch-${token}`}>
                        <span className="swatches__chip" data-token={token} aria-hidden="true" />
                        <span className="swatches__name">{token}</span>
                        <code className="swatches__value">{`var(--${token})`}</code>
                    </li>
                ))}
            </ul>
        </SettingsWorkspace>
    );
}
