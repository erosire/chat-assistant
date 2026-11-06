// Add-on plugin seam — the chat build's capability set beyond the T3 core.
//
// `createChatDashboard` appends this array AFTER the chat plugin set, so anything
// registered here may depend on every built-in capability (cells, services,
// commands, events) and nothing built-in may depend on it. T3 left it EMPTY on
// purpose; T6 fills it with the capabilities the later tasks built, in the order
// they must run.
//
// ORDER (and why each edge is where it is):
//   1. `chat.agents`   — owns the `chat.agentStore` service and chat.agent.*
//      commands; seeds `chat.agents` from localStorage.
//   2. `chat.tools`    — owns `chat.toolStore` and chat.tool.*; reads the agent
//      registry only through the cells, so its position after agents is cosmetic
//      rather than load-bearing (the two never call each other).
//   3. `chat.settings` — chat.mode.set / chat.providerBase.set. It executes
//      `chat.message.cancel` when a provider-base edit lands mid-stream, and that
//      command belongs to chat.source (already registered above), which is the one
//      ordering fact this plugin depends on.
//   4. `chat.voice`    — owns the `chat.speech` service and chat.voice.*; it
//      executes chat.message.send / chat.message.cancel for the auto-send rule, so
//      it also sits after the chat set.
//   5. `chat.notices`  — LAST of the reactive add-ons on purpose: it subscribes to
//      `chat.error` / `chat.notice` / `chat.stream.completed` /
//      `chat.transcript.updated`, i.e. to the feedback every earlier plugin emits.
//      Registering it first would not lose events (events are live-only and this
//      runs at setup, before any flow starts), but it makes the strip's row order
//      and the "cleared by a successful action" rule depend on nothing but the
//      graph.
//   6. `chat.inputs`   — chat.draft.set / chat.model.set, the two contract commands
//      no other plugin registered (see plugins/inputs.ts's header).
//   7. `chat.surfaces` — the region contributions, so it claims the channels
//      after every capability exists; the shell renders the LAST contribution per
//      channel, and this is the last one (orders 40/50/60).
//
// NO DUPLICATE IDS anywhere in this list: `chat.agentStore`, `chat.toolStore`,
// `chat.speech` and `chat.notices` are registered by the plugins that own them, and
// `chat.agent.set` belongs to `chat.agents` — an add-on that re-registered any of
// these would discard the whole build with 'duplicate-service' /
// 'duplicate-command' before a single setup() finished.
import type { DashboardPlugin } from '@underload/dashboard';
import { createAgentsPlugin } from './agents';
import { createToolsPlugin } from './tools';
import { createSettingsPlugin } from './settings';
import { createVoicePlugin } from './voice';
import { createNoticesPlugin } from './notices';
import { createInputsPlugin } from './inputs';
import { createSurfacesPlugin } from './surfaces';

export const EXTRA_PLUGINS: DashboardPlugin[] = [
    createAgentsPlugin(),
    createToolsPlugin(),
    createSettingsPlugin(),
    createVoicePlugin(),
    createNoticesPlugin(),
    createInputsPlugin(),
    createSurfacesPlugin()
];
