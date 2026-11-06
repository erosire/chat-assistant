// ChatInspector — the ASIDE region's slot contribution (T6, the real surface).
//
// WHAT IT IS: the workstation's inspector column. One owner per region (see
// pickRegionOwner in ../WorkstationShell.tsx), and this column's content follows
// whichever registry the rail is showing, so the operator edits in one place what
// they picked in the other. The tab is read from `chat.sidebarTab` (registered by
// plugins/core.ts, written by ChatSidebar's tab strip and by `chat.agent.create` /
// `chat.tool.create` — plugins/agents.ts:94, plugins/tools.ts:134 — which is how
// creating an agent or a tool moves the aside onto it without any cross-plugin
// call).
//
// THE FOUR CASES (contract.ts's `SidebarTab` vocabulary, exhaustive):
//   'agent'    -> AgentWorkspace   (registry list + prompt editor + tool toggles)
//   'tool'     -> ToolInspector    (registry grid + source editor)
//   'settings' -> StationSettings  (mode + offline base + skin switches)
//   'chat'     -> the quiet panel below: a conversation has no inspector. The
//                 transcript's own details (usage, model, tokens) already live in
//                 the composer's `token-usage` row and the rail's Settings tab, so
//                 inventing a fourth conversation panel here would duplicate a
//                 surface that already exists — the oracle's own aside equivalent
//                 renders nothing for the Chat tab (its aside tabs are Agent /
//                 Tool / Settings only).
//
// WHY A WRAPPER RATHER THAN THREE CONTRIBUTIONS: the shell keeps the LAST
// contribution of a channel, so three contributions in `layout.aside` would leave
// three owners and two invisible. One wrapper also gives the column its contract
// testid (`aside-panel`, see the grammar in ../contract.ts:46) and the
// `.inspector` flex column (styles/base.css, "Region owners") that lets each
// feature surface keep its own root class (`.agents` / `.tools` / `.settings`),
// which those files' rules already size.
import {
    CHAT_SIDEBAR_TAB_STATE,
    type SidebarTab
} from '../contract';
import { useDashboardValue } from '../state-hooks';
import { AgentWorkspace } from './AgentWorkspace';
import { StationSettings } from './StationSettings';
import { ToolInspector } from './ToolInspector';

/** The idle panel's copy — one place, so the wording stays consistent. */
const IDLE = {
    title: 'Inspector',
    hint: 'chat',
    body: 'This column follows the rail. Pick Agent, Tool or Settings to edit that registry here.'
} as const;

/**
 * The surface for one rail tab. Total by construction: `SidebarTab` is a closed
 * union, so a new tab value is a compile error here instead of a blank column.
 */
const surfaceFor = (tab: SidebarTab) => {
    if (tab === 'agent') return <AgentWorkspace />;
    if (tab === 'tool') return <ToolInspector />;
    if (tab === 'settings') return <StationSettings />;
    // 'chat': the quiet panel. Reuses the shell's descriptor chrome classes
    // (`.panel*`, styles/base.css:156-196) because that is exactly the state they
    // were built for — a column with a title and nothing registered in it.
    return (
        <section className="panel" data-testid="inspector-idle" aria-label="Inspector">
            <header className="panel__head">
                <h2 className="panel__title">{IDLE.title}</h2>
                <span className="panel__hint">{IDLE.hint}</span>
            </header>
            <div className="panel__body">
                <p className="panel__empty">{IDLE.body}</p>
            </div>
        </section>
    );
};

export function ChatInspector() {
    const tab = useDashboardValue<SidebarTab>(CHAT_SIDEBAR_TAB_STATE);

    return (
        <div className="inspector" data-testid="aside-panel">
            {surfaceFor(tab)}
        </div>
    );
}
