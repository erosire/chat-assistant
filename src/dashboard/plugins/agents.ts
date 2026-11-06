// Chat AGENTS plugin: the client-side agent registry.
//
// WHAT THIS IS (behavior oracle: src/components/ChatAssistantApp.tsx):
//   `startNewAgent`      :3441-3450  -> chat.agent.create
//   `updateAgent`        :3452-3457  -> chat.agent.save   (the whole definition,
//                                                          patch merged by the caller)
//   `deleteAgent`        :3459-3470  -> chat.agent.delete
//   `agentChoice(...)`   :5109-5110  -> chat.agent.set    (the composer's picker,
//                                                          i.e. the agent whose block
//                                                          prefixes NEW chats)
//   `persistAgents`      :3350-3356  -> the AgentStore facade (services/registries.ts)
//
// NO EPOCH GUARD HERE, ON PURPOSE. Every flow below is a synchronous localStorage
// round trip: there is no await between reading and writing, so there is no
// in-flight settle to detach. The oracle says the same thing in its own comment on
// `deleteAgent` (:3459-3466 — "agents are pure client-side presets (src/agents), so
// there is no server record to delete and no mode namespace to guard"). A mode
// switch therefore never invalidates an agent edit, which is why this plugin does
// not read `chat.cells.epoch` and does not take a `chat.cells.activity` slot.
//
// NO STATE CELLS REGISTERED. The core plugin owns all 27 `chat.*` cells (see
// plugins/core.ts:1-11 for why only one plugin may), including `chat.agents`,
// `chat.activeAgentId` and `chat.agent`; this plugin reaches them through the
// `chat.cells` service and only WRITES them.
//
// WHY `chat.agents` IS RE-PUBLISHED FROM THE STORE ON EVERY COMMAND. The store is
// the durable truth (src/agents/index.ts `readStoredAgents`/`storeAgents`, key
// `chat-assistant:agents`); the cell is its projection. Writing the store's freshly
// read list — instead of patching the cell locally — keeps the two from diverging
// and gives every subscriber a genuinely new reference, which the SameValueZero
// change detection needs to notify at all (see state-hooks.ts:26-29).
import type { DashboardPlugin } from '@underload/dashboard';
import { createAgentDefinition, type AgentDefinition } from '../../agents';
import { createAgentStore, type AgentStore } from '../services/registries';
import {
    CHAT_AGENT_CREATE_COMMAND,
    CHAT_AGENT_DELETE_COMMAND,
    CHAT_AGENT_SAVE_COMMAND,
    CHAT_AGENT_SET_COMMAND,
    CHAT_AGENT_STORE_SERVICE,
    CHAT_CELLS_SERVICE,
    PLUGIN_IDS,
    type ChatCells
} from '../contract';

/**
 * Plugin id. contract.ts's `PLUGIN_IDS` map is frozen by another task and carries
 * no agents/tools entry, so the add-on seam declares its own (the ids follow the
 * `chat.*` vocabulary of the plugins it sits after, see plugins/extras.ts:9-13).
 */
export const AGENTS_PLUGIN_ID = 'chat.agents';

/**
 * Build the agents plugin for one dashboard.
 * No options: the agent registry has no endpoint (localStorage only, per the oracle).
 */
export function createAgentsPlugin(): DashboardPlugin {
    return {
        id: AGENTS_PLUGIN_ID,
        // Reads `chat.cells` during setup, so the core must have run first
        // (`requires` ORDERS but does not validate — see composition.ts:9-16).
        requires: [PLUGIN_IDS.chatCore],
        setup(api) {
            const cells = api.getService<ChatCells>(CHAT_CELLS_SERVICE);
            const store = createAgentStore();

            // Publish the store facade (services/registries.ts:134-149) and adopt
            // whatever the browser already has. The core seeds `chat.agents` from
            // `readStoredAgents()` too (plugins/core.ts:406-408); this is the same
            // read through the facade this plugin owns, and it is what makes the
            // cell non-negotiably store-backed from the first frame.
            api.service<AgentStore>(CHAT_AGENT_STORE_SERVICE, store);
            cells.agents.set(Object.freeze(store.list()));

            /** Project the persisted registry into the cell the views read. */
            const publishAgents = (): void => {
                cells.agents.set(Object.freeze([...store.list()]));
            };

            /**
             * chat.agent.create — the oracle's `startNewAgent` (:3441-3450).
             * `createAgentDefinition` allocates the lowest free `agent-N` id, so a
             * testid like `agent-row-agent-1` never shifts when a middle agent was
             * deleted (src/agents/index.ts:138-146). The new agent is appended
             * (store upsert semantics), OPENED (`chat.activeAgentId`) and the rail is
             * switched to the Agent tab, exactly as the oracle did. No conversation
             * state is touched — that is what makes this different from New chat.
             */
            api.command<void, string>(CHAT_AGENT_CREATE_COMMAND, () => {
                const agent = createAgentDefinition(store.list());
                store.save(agent);
                publishAgents();
                cells.activeAgentId.set(agent.id);
                cells.sidebarTab.set('agent');
                return agent.id;
            });

            /**
             * chat.agent.save — the oracle's `updateAgent` (:3452-3457).
             * The caller sends the WHOLE definition (the surface patches it through
             * the pure helpers in src/agents: `appendAgentMessage`,
             * `updateAgentMessage`, `updateAgentMessageRole`, `removeAgentMessage`,
             * `toggleAgentTool`), because "identities are immutable" — `id` is never
             * patched. Every keystroke lands here: there is no draft/commit split in
             * the agent editor (:488-492), so an interrupted edit is already saved.
             */
            api.command<AgentDefinition, void>(CHAT_AGENT_SAVE_COMMAND, (agent) => {
                // A payload with no id cannot address a registry row; ignoring it
                // beats writing an entry the store would then never find again.
                if (!agent || typeof agent.id !== 'string' || agent.id.length === 0) return;
                store.save(agent);
                publishAgents();
            });

            /**
             * chat.agent.delete — the oracle's `deleteAgent` (:3459-3470).
             * Deleting the OPEN agent drops the selection so the surface falls back
             * to its empty state instead of rendering a definition that no longer
             * exists (:4571-4578 in the oracle). The composer's agent prefix
             * (`chat.agent`) is cleared too: the oracle left the dead id there, where
             * every read resolved it to null / the picker's "None" label
             * (`agentDisplay`, :4347), and an explicit empty id is the same
             * observable state through a cheaper contract.
             */
            api.command<string, void>(CHAT_AGENT_DELETE_COMMAND, (id) => {
                if (!id) return;
                store.remove(id);
                publishAgents();
                if (cells.activeAgentId.get() === id) cells.activeAgentId.set(null);
                if (cells.agent.get() === id) cells.agent.set('');
            });

            /**
             * chat.agent.set — the composer's picker (contract `string -> void`,
             * '' clears). A plain validated cell write: `chat.agents` is the option
             * source and the send flow resolves the prefix at send time
             * (plugins/core.ts:332-338 `resolveAgentPrefix`), so nothing else has to
             * react to the write. ChatSidebar executes this id for its Agent-tab rows.
             */
            api.command<string, void>(CHAT_AGENT_SET_COMMAND, (agentId) => {
                const next = typeof agentId === 'string' ? agentId : '';
                // A row that is no longer in the registry cannot prefix a chat; the
                // picker cannot produce one, but a stale view or an add-on can.
                if (next !== '' && !cells.agents.get().some((agent) => agent.id === next)) return;
                if (next === cells.agent.get()) return;
                cells.agent.set(next);
            });
        }
    };
}

/** The default-configured agents plugin. */
export const agentsPlugin: DashboardPlugin = createAgentsPlugin();
