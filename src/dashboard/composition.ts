// Composition root: one dashboard() call, the plugins that make the chat UI.
//
// Adapted from packages/underload/dashboard/example/src/app/composition.ts.
// T1 registered only the two skin plugins; T3 added the chat core (the whole
// `chat.*` state graph, the session lifecycle, the streaming send pipeline, the
// message/turn commands and the system-prompt flow); T6 filled the add-on seam
// (plugins/extras.ts) with the capability set — agents, tools, settings, voice,
// notices, the two input commands and the three region surfaces — so the graph this
// file builds is the complete workstation:
//
//   layout -> theme -> chat.core -> chat.source -> chat.sessions ->
//   chat.transcript -> chat.system-prompt -> chat.agents -> chat.tools ->
//   chat.settings -> chat.voice -> chat.notices -> chat.inputs -> chat.surfaces
//
// ORDER MATTERS (documented because the next contributor will hit it):
//   `requires` is the only ordering mechanism, and it ORDERS but does not
//   validate providers — declare an edge for every service a setup() reads, or
//   the lookup is a lucky coincidence (`unknown-service` otherwise). The chat
//   plugins declare `requires: ['chat.core']`, which is what makes the schedule
//   deterministic regardless of how this array is spelled.
//   Add-ons are appended last: they may depend on every built-in, and no built-in
//   can depend on them.
//
// Duplicate ids anywhere in the graph throw before a single setup() runs, so a
// plugin that registered a `chat.*` id owns it: see contract.ts for the reserved
// vocabulary and the command signatures each id must honour. The add-ons' services
// (`chat.agentStore`, `chat.toolStore`, `chat.speech`, `chat.notices`) and the
// `chat.agent.set` command are registered ONCE, by the plugins that own them.
import { dashboard, type Dashboard, type DashboardPlugin } from '@underload/dashboard';
// The public `baseUrl`/`providerUrl` props keep their PRE-REBUILD meaning, which
// is the FULL endpoint on both sides — not a bare origin. Passing an origin here
// is the drift this file previously carried: the storage client appends
// '/{conversationId}' to whatever it is given (api/chat-assistant.ts:142-145), so
// an origin silently repointed every conversation route at the storage ROOT, and
// the provider derives '{base}/models' and '{base}/chat/completions' from ITS base
// (api/provider.ts:107, :234), so an origin there is the recorded
// "No models available" bug (api/provider.ts:9-19).
import { DEFAULT_CHAT_ASSISTANT_URL } from '../api/chat-assistant';
import { DEFAULT_PROVIDER_URL } from '../api/provider';
import { createLayoutPlugin } from './plugins/layout';
import { createThemePlugin } from './plugins/theme';
import { createChatPlugins } from './plugins/chat';
import { EXTRA_PLUGINS } from './plugins/extras';

export type ChatDashboardOptions = {
    /**
     * Conversation-storage ENDPOINT (default: DEFAULT_CHAT_ASSISTANT_URL, i.e.
     * '{origin}/v1/chat-assistant/conversation'). Threaded into the
     * `chat.conversations` service every chat flow reads.
     */
    baseUrl?: string;
    /**
     * Inference-provider BASE for ONLINE mode (default: DEFAULT_PROVIDER_URL, i.e.
     * '{origin}/providers/private/v1'). Threaded into the `chat.provider` service;
     * OFFLINE mode overrides it at runtime through the `chat.providerBase` cell,
     * which is why `chat.conversations` resolves the live cells on every call.
     */
    providerUrl?: string;
    /**
     * Poll cadence for an in-flight ('pending') conversation (R14). Defaults to
     * `CONVERSATION_POLL_INTERVAL_MS`; overridable for tests.
     */
    pollIntervalMs?: number;
    /**
     * Capability add-ons appended after the built-ins. This is the seam the shell
     * test uses to prove the shell is feature-blind: a contribution from a plugin
     * the shell has never heard of still renders, in slot order, with no edit
     * here or in WorkstationShell.tsx.
     */
    extraPlugins?: readonly DashboardPlugin[];
};

export function createChatDashboard(options: ChatDashboardOptions = {}): Dashboard {
    // A mutable array satisfies both `DashboardPlugin[]` and the core's
    // `readonly DashboardPlugin[]` input, so a call site cannot break on that
    // detail of the public type.
    const plugins: DashboardPlugin[] = [
        // 1. layout: publishes `layout.brand` + `layout.regions` and the three
        //    replaceable region placeholders.
        createLayoutPlugin(),
        // 2. theme: owns `ui.theme` / `ui.density` / `ui.motion` and the commands
        //    the bar's skin affordances call.
        createThemePlugin(),
        // 3-7. the chat core: state graph -> transport -> sessions -> transcript
        //        -> system prompt. Built per instance so the endpoints below reach
        //        the services (see plugins/chat.ts for why both this factory and
        //        the default `chatPlugins` array exist).
        ...createChatPlugins({
            baseUrl: options.baseUrl ?? DEFAULT_CHAT_ASSISTANT_URL,
            providerUrl: options.providerUrl ?? DEFAULT_PROVIDER_URL,
            ...(options.pollIntervalMs !== undefined
                ? { pollIntervalMs: options.pollIntervalMs }
                : {})
        }),
        // 8-14. the add-on capabilities, in the order documented in
        //       plugins/extras.ts: agents -> tools -> settings -> voice -> notices
        //       -> inputs -> surfaces. Every one of them is stateless at the FACTORY
        //       level (its per-instance state is created inside setup()), so the same
        //       module-level plugin objects are safe across two dashboards — the
        //       option-bearing add-ons (voice's speech client, notices' row cap) keep
        //       their own factory signatures for a variant build that needs them.
        //       `chat.surfaces` is last on purpose: the shell renders the FINAL
        //       contribution of a channel (WorkstationShell.tsx:62-81).
        ...EXTRA_PLUGINS,
        ...(options.extraPlugins ?? [])
    ];

    return dashboard({ plugins });
}
