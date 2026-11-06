// SETTINGS plugin: the two configuration commands the settings surface drives.
//
// WHAT THIS PLUGIN IS (and why it is so small): the online/offline switch and the
// single offline provider base are the whole assistant configuration
// (api/offline.ts `AssistantSettings`). The CELLS already exist — the chat core
// registers `chat.mode` / `chat.providerBase`, seeds both from localStorage
// (plugins/core.ts:360-367) and owns everything that FOLLOWS a write through its
// own cell subscriptions:
//
//   cells.mode.set(x)          -> core bumps BOTH epochs, resets the namespace
//                                 (sessions/transcript/usage/pending/streaming/
//                                 models/collapse/prompt/editors/busy flags/error/
//                                 active id) and re-persists the settings
//                                 (plugins/core.ts:553-569, resetNamespace :533-552);
//   cells.providerBase.set(x)  -> core re-persists the settings (:575-584).
//
// So a settings command that persists and writes the cell is already
// feature-complete (the seam plugins/extras.ts:19-24 documents for T5), and this
// file adds only what the core's subscriptions cannot do by themselves:
//   1. validation (commands are reachable from untyped `instance.execute` callers);
//   2. the immediate persist at the command site, so the write is ordered and
//      its failure is reportable (the core's re-persist is the second net);
//   3. the R7 namespace reset called out EXPLICITLY (activity.reset()), so the
//      guarantee does not depend on which plugin happened to own the cell write;
//   4. the in-flight stream invalidation a provider-base edit implies (a reply
//      streaming from the OLD base is no longer the answer being configured);
//   5. the human-readable consequence of each change on the notice strip.
//
// NO REACT, NO JSX, NO DOM. Every persisted byte goes through api/offline.ts.
import type { DashboardPlugin } from '@underload/dashboard';
import { loadAssistantSettings, saveAssistantSettings } from '../../api/offline';
import {
    CHAT_ACTIVITY_SERVICE,
    CHAT_CELLS_SERVICE,
    CHAT_ERROR_EVENT,
    CHAT_MESSAGE_CANCEL_COMMAND,
    CHAT_MODE_SET_COMMAND,
    CHAT_NOTICE_EVENT,
    CHAT_PROVIDER_BASE_SET_COMMAND,
    PLUGIN_IDS,
    type ChatActivity,
    type ChatCells,
    type ChatMode,
    type NoticeEvent
} from '../contract';

// The accepted mode set, declared as data so the runtime guard and the settings
// <select> describe the same vocabulary (the `ChatMode` union is the compile-time
// half). Same discipline as plugins/theme.ts:28-30.
const MODES: readonly ChatMode[] = Object.freeze(['online', 'offline']);

/**
 * Storage is best-effort HERE and loud about the failure: `saveAssistantSettings`
 * re-throws a locked-down profile (api/offline.ts:153-160) rather than dropping the
 * configuration silently, and the surface must stay usable — the mode DOES change
 * for this session, only the reload-restore is lost (the same reading the core
 * documents at plugins/core.ts:557-568).
 */
export const SETTINGS_PERSIST_FAILED =
    'Settings changed for this session, but this browser blocked localStorage, so they will not be restored after a reload.';

/** One row of the notice strip: what the operator just did, in plain words. */
export const modeNotice = (mode: ChatMode): string =>
    mode === 'offline'
        ? 'Offline mode: conversations are stored in this browser and the provider base URL below answers for inference.'
        : 'Online mode: conversations use the application storage server and the private provider relay.';

/**
 * Persist one settings snapshot in the canonical single-base form
 * (`saveAssistantSettings` trims and strips trailing slashes itself). Returns false
 * only when the write actually failed, which is what decides whether the operator
 * gets a notice or a warning in the banner.
 */
const persistSettings = (mode: ChatMode, providerBase: string): boolean => {
    try {
        saveAssistantSettings({
            mode: mode === 'offline' ? 'offline' : 'online',
            providerBase
        });
        return true;
    } catch {
        return false;
    }
};

/**
 * Read the persisted settings without ever throwing: `loadAssistantSettings`
 * already degrades a corrupt/legacy object to the online default
 * (api/offline.ts:133-146), so a hostile localStorage cannot fail the dashboard here
 * (a plugin that throws during setup discards the whole build, 'setup-failed').
 */
const readPersistedSettings = (): { mode: ChatMode; providerBase: string } => {
    const settings = loadAssistantSettings();
    return {
        mode: settings.mode === 'offline' ? 'offline' : 'online',
        providerBase: settings.providerBase
    };
};

export function createSettingsPlugin(): DashboardPlugin {
    return {
        id: PLUGIN_IDS.chatSettings,
        // The cells handle is resolved DURING setup (the seeding below), so the edge
        // is mandatory: `requires` orders setups, it does not validate providers.
        requires: [PLUGIN_IDS.chatCore],
        setup(api) {
            const cells = api.getService<ChatCells>(CHAT_CELLS_SERVICE);
            const activity = api.getService<ChatActivity>(CHAT_ACTIVITY_SERVICE);

            // ——— seeding ————————————————————————————————————————————————————————
            // The core plugin ALREADY seeds both cells from the persisted settings
            // (plugins/core.ts:355, :360-367), so both comparisons below are equal
            // writes: `DashboardState.set` is SameValueZero, notifies nobody and
            // therefore triggers no epoch bump (types/index.ts:19-28). The writes are
            // kept as the documented safety net for a variant composition whose core
            // starts from different defaults — a real mismatch lands BEFORE any flow
            // can snapshot the guard, so it costs one namespace reset, not a race.
            const persisted = readPersistedSettings();
            if (cells.mode.get() !== persisted.mode) cells.mode.set(persisted.mode);
            if (cells.providerBase.get() !== persisted.providerBase) {
                cells.providerBase.set(persisted.providerBase);
            }

            /**
             * Surface a persistence failure. Written AFTER the cell write on purpose:
             * the core's namespace reset clears `chat.error` (plugins/core.ts:548), so
             * a warning raised before the reset would be swallowed. Both the cell and
             * the event go out, the same pair every other chat plugin reports with
             * (plugins/sessions.ts:152-154), and `chat.notices` keeps the last one.
             */
            const reportPersistence = (): void => {
                cells.error.set(SETTINGS_PERSIST_FAILED);
                const notice: NoticeEvent = { message: SETTINGS_PERSIST_FAILED };
                api.emit(CHAT_ERROR_EVENT, notice);
            };

            // ——— `chat.mode.set` —————————————————————————————————————————————————
            api.command<ChatMode, void>(CHAT_MODE_SET_COMMAND, (next) => {
                // Commands run through `instance.execute`, i.e. from untyped callers
                // too, so the value is validated at the seam (theme.ts:89-91 idiom).
                if (!MODES.includes(next)) {
                    throw new Error(`Unknown chat mode: ${String(next)}`);
                }
                // Same mode: the oracle's `switchMode` returns BEFORE bumping its
                // epoch (components/ChatAssistantApp.tsx:3388-3389), so re-picking the
                // live mode detaches nothing that is running.
                if (cells.mode.get() === next) return;

                // Persist FIRST: a reload restores the mode even if a later reset
                // throws, and the cell write below is what the core's subscription
                // persists a second time (plugins/core.ts:561-568).
                const persistedNow = persistSettings(next, cells.providerBase.get());

                // The cell write IS the namespace reset (R7). Everything that
                // snapshotted the old pair settles into the namespace it started in —
                // its storage write still lands there, its surface paints nothing, and
                // its stale finally cannot retake a busy flag here.
                cells.mode.set(next);

                // Explicit for the brief's guarantee and cheap to keep: the busy
                // counters belong to the namespace being left. The core's
                // `resetNamespace` already calls this through the same subscription
                // (plugins/core.ts:547), and a second `reset()` re-publishes 'idle',
                // which is an equal write (no notification), so the belt is free.
                activity.reset();

                // The sidebar and the catalog follow the CELL, not this command, so no
                // plugin has to be called into:
                //   sessions: cells.mode.subscribe(refreshSessions) — plugins/sessions.ts:348-350
                //   source:   cells.mode.subscribe(refreshModels)   — plugins/source.ts:812-816
                // Neither plugin exposes a callable seam (no service), which is why the
                // documented seam for a mode switch is the cell subscription itself.
                if (!persistedNow) reportPersistence();

                const notice: NoticeEvent = { message: modeNotice(next) };
                api.emit(CHAT_NOTICE_EVENT, notice);
            });

            // ——— `chat.providerBase.set` —————————————————————————————————————————
            api.command<string, void>(CHAT_PROVIDER_BASE_SET_COMMAND, (raw) => {
                const next = typeof raw === 'string' ? raw : '';
                // Unchanged base: no persist, no cancelled stream, no catalog refetch
                // (the oracle's `updateProviderBase` re-ran the catalog effect for a
                // REAL change only, components/ChatAssistantApp.tsx:3425-3427).
                if (cells.providerBase.get() === next) return;

                // Persist the CANONICAL form (api/offline.ts:153-160 trims and strips
                // trailing slashes) while the CELL keeps the raw value: the oracle held
                // the untrimmed string in state so typing stayed fluid, trimming only
                // on persistence and on use (:3360-3362).
                const persistedNow = persistSettings(cells.mode.get(), next);

                // Invalidate an in-flight stream: the reply is arriving from the base
                // the operator just replaced, so keeping it would paint an answer that
                // belongs to the previous configuration. The busy check gates the
                // command lookup — `chat.message.cancel` is registered by chat.source,
                // and a composition without it can never be 'sending', so no variant
                // build reaches an `unknown-command`.
                if (activity.isBusy('sending')) {
                    // The cancel branch restores the draft into the composer for a
                    // retry (plugins/source.ts:550-563); the stream's own persisted
                    // partial stays in the namespace it started in.
                    api.execute<void, boolean>(CHAT_MESSAGE_CANCEL_COMMAND);
                }

                // LAST: the write is what re-persists (core) and re-reads the model
                // catalog for the new base (source's providerBase subscription,
                // plugins/source.ts:817-819 — a BLANK base issues no request at all,
                // plugins/source.ts:740-748).
                cells.providerBase.set(next);

                if (!persistedNow) reportPersistence();
            });

            // Nothing is subscribed and no timer runs here: every consequence of these
            // two writes is a cell subscription owned by the core/sessions/source
            // plugins, and those drop themselves on teardown.
        }
    };
}

/** The default-configured settings plugin. */
export const settingsPlugin: DashboardPlugin = createSettingsPlugin();
