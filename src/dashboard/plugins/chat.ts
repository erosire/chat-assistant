// The chat plugin set — one ordered array, no composition logic.
//
// ORDER AND EDGES (both matter, and neither is obvious from the array):
//   `chat.core` registers every `chat.*` cell, the `chat.cells` handle service and
//   the epoch guard, so it runs first. The other four declare
//   `requires: ['chat.core']`, which is what makes their setup-time
//   `api.getService(CHAT_CELLS_SERVICE)` defined rather than a lucky coincidence
//   (see composition.ts's header note: `requires` ORDERS, it does not validate).
//   The remaining services in this distribution's contract — `chat.agentStore`,
//   `chat.toolStore`, `chat.speech` — are registered by the agents/voice plugins,
//   which may be ordered AFTER this set, so every handler here resolves them
//   lazily at call time (never captured during setup).
//
// WHY BOTH AN ARRAY AND A FACTORY:
//   the T3 brief pins `chatPlugins` as the export other tasks read, but the
//   storage/provider endpoints are PER-DASHBOARD values (a test points them at its
//   own origins, an embedder passes its own props). `createChatPlugins(options)` is
//   the option-aware seam composition.ts uses; `chatPlugins` is the same set built
//   from the deployment defaults, exported for anyone composing the default
//   workstation.
import type { DashboardPlugin } from '@underload/dashboard';
import { createCorePlugin, corePlugin } from './core';
import { createSessionsPlugin, sessionsPlugin } from './sessions';
import { createSourcePlugin, sourcePlugin } from './source';
import { createTranscriptPlugin, transcriptPlugin } from './transcript';
import { createSystemPromptPlugin, systemPromptPlugin } from './system-prompt';
import type { ChatPluginOptions } from './options';

/**
 * Build the chat plugin set for ONE dashboard.
 * The returned array is freshly constructed on every call, so two dashboards with
 * different endpoints never share an instance's options.
 */
export function createChatPlugins(options: ChatPluginOptions = {}): DashboardPlugin[] {
    return [
        // 1. state graph: every `chat.*` cell, the cells service, the epoch guard
        //    and the derived `chat.turns` writer.
        createCorePlugin(options),
        // 2. transport: `chat.conversations` (mode-routing) + `chat.provider`,
        //    the send/cancel pipeline, the model catalog and the R14 poller.
        //    Declared BEFORE the session flows because sessions/transcript/system
        //    pin a namespace store imported from this module.
        createSourcePlugin(options),
        // 3. conversation lifecycle: create / select / delete / rename.
        createSessionsPlugin(options),
        // 4. message and turn commands: copy / fork / role / delete / update,
        //    collapse, autoscroll and the composer focus handoff.
        createTranscriptPlugin(options),
        // 5. the system prompt: draft, save, cancel.
        createSystemPromptPlugin(options)
    ];
}

// The default-configured set, in the same order (core first, then the four flows).
export const chatPlugins: readonly DashboardPlugin[] = [
    corePlugin,
    sourcePlugin,
    sessionsPlugin,
    transcriptPlugin,
    systemPromptPlugin
] as const;

export {
    corePlugin,
    sourcePlugin,
    sessionsPlugin,
    transcriptPlugin,
    systemPromptPlugin,
    createCorePlugin,
    createSourcePlugin,
    createSessionsPlugin,
    createTranscriptPlugin,
    createSystemPromptPlugin
};
