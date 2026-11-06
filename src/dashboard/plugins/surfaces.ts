// Chat SURFACES plugin: the real region contributions (T6).
//
// This is where the rebuilt UI becomes visible. Everything before it in the graph
// is headless (cells, services, commands, events); the shell renders whatever is in
// the three region channels, so contributing here — and nowhere else — is what puts
// the station on screen (../WorkstationShell.tsx renders each region's LAST
// contribution, see pickRegionOwner there and the band contract in
// WorkstationShell.tsx:62-81).
//
// ORDER BANDS (final, and they never tie inside a channel):
//   0   layout.ts descriptor placeholders (the "nothing registered" fallback:
//       panel chrome + a string, used only when a channel has no owner)
//   10/20/30  were T3's component placeholders inside plugins/core.ts. They are
//       GONE: the real surfaces replaced them, and a placeholder that no region
//       renders is dead weight in the bundle (components/Placeholder*.tsx deleted).
//   40/50/60  the three real surfaces below. They are spread across bands rather
//       than sharing one number because the band is documented per CHANNEL in
//       contract.ts (10 sidebar / 20 stage / 30 inspector / 40 add-on); keeping a
//       distinct number per channel makes an add-on that wants to replace ONE
//       column obvious (it takes that channel's band + 10) and keeps the "never tie
//       inside a channel" rule checkable by eye in WorkstationShell.test.tsx.
//
// WHY A PLUGIN INSTEAD OF EDITING composition.ts: the shell stays feature-blind (it
// has no import of any chat component), and a variant build can drop the surfaces
// and keep the graph — which is exactly what the headless plugin tests do.
//
// WHY THE STAGE AND ASIDE ARE WRAPPERS: one contribution per channel means one
// component per column. The stage column really holds two surfaces (the notice
// strip and the stage proper) and the aside holds one of four, so ChatStageSlot and
// ChatInspector do that composing (see their files); ChatSidebar already owns its
// whole rail and needs no wrapper.
import type { DashboardPlugin } from '@underload/dashboard';
import {
    ASIDE_SLOT,
    CHAT_CELLS_SERVICE,
    PLUGIN_IDS,
    SIDEBAR_SLOT,
    STAGE_SLOT,
    type ChatCells,
    type PanelValue
} from '../contract';
import {
    ChatInspector,
    ChatSidebar,
    ChatStageSlot
} from '../components';

/**
 * Plugin id — same add-on convention as plugins/inputs.ts:46 and
 * plugins/agents.ts:51: `PLUGIN_IDS` is frozen, so the seam names its own id in the
 * `chat.*` vocabulary.
 */
export const SURFACES_PLUGIN_ID = 'chat.surfaces';

/**
 * Build the surfaces plugin for one dashboard.
 * No options: a contribution's value is a component reference, and every component
 * reaches its data through the instance (../state-hooks.ts), not through props.
 */
export function createSurfacesPlugin(): DashboardPlugin {
    return {
        id: SURFACES_PLUGIN_ID,
        // Two reasons the edge is real and not decorative: the channels this plugin
        // claims are only meaningful once the chat core has registered the cells its
        // components read, and `requires` is the only ordering mechanism the
        // scheduler has (composition.ts:9-16). The handle is resolved during setup
        // purely to assert that dependency at build time — a composition without the
        // core fails HERE, with 'unknown-service', instead of rendering a station
        // whose every hook throws 'unknown-state' on the first paint.
        requires: [PLUGIN_IDS.chatCore],
        setup(api) {
            api.getService<ChatCells>(CHAT_CELLS_SERVICE);

            // The rail: sessions / agents / tools / settings tabs, the drawer and its
            // scrim (components/ChatSidebar.tsx).
            api.slot<PanelValue>(SIDEBAR_SLOT, {
                id: 'chat.sidebar',
                order: 40,
                value: { component: ChatSidebar }
            });

            // The stage: notice strip + transcript + error strip + composer.
            api.slot<PanelValue>(STAGE_SLOT, {
                id: 'chat.stage',
                order: 50,
                value: { component: ChatStageSlot }
            });

            // The inspector: the surface `chat.sidebarTab` selects.
            api.slot<PanelValue>(ASIDE_SLOT, {
                id: 'chat.inspector',
                order: 60,
                value: { component: ChatInspector }
            });

            // Slot registrations are frozen at composition time, so there is nothing
            // to tear down.
        }
    };
}

/** The surfaces plugin (stateless, so one instance is reusable across builds). */
export const surfacesPlugin: DashboardPlugin = createSurfacesPlugin();
