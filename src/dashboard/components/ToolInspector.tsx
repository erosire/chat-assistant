// ToolInspector — the tool registry surface: the rows, and the selected tool's panel.
//
// BEHAVIOR ORACLE (read-only): src/components/ChatAssistantApp.tsx
//   `ToolWorkspace` (the content-area panel)     :511-529  + render site 4784-4795
//   `ToolCodeBlock` (the mono source panel)      :531-549
//   `toolKindLabel` (native vs JS/TS copy)       :551-555
//   the Tool tab's registry rows                 :4621-4648
//   the tab's empty state                        :4796-4801
//
// WHAT IS READ-ONLY AND WHAT IS EDITABLE, and why that is the honest split here.
// The oracle renders the selected tool as pure display: its name in a `<strong>`,
// the kind line, then either the "provided by the runtime" note or the source block
// — no control writes back to a tool, because the oracle's registry is the frozen
// `AVAILABLE_TOOLS` seed with no persistence at all. The contract still pins
// `chat.tool.create` / `chat.tool.save` / `chat.tool.delete`, and this distribution
// DOES have a durable tool store (`chat-assistant:tools`, services/registries.ts
// :9-19), so the surface has to be able to reach those commands:
//   - a NATIVE tool stays exactly as the oracle drew it (name, kind, the runtime
//     note). Its identity, its name and its presence come from the runtime seed, and
//     `ToolStore` merge rule is "the NATIVE SEED wins" (:152-165) — a rename of a
//     native row would be written and then silently overridden on the next read, so
//     drawing a text field for it would promise a persistence that cannot happen.
//   - a CODED (non-native) tool is editable: name, language and source, each
//     persisted immediately through `chat.tool.save` — the same no-draft/commit rule
//     the agent editor uses (AgentWorkspace.tsx, oracle :488-492). Its source field
//     keeps the oracle's `tool-code` testid and mono treatment, upgraded from a
//     `<pre>` to a textarea so the code the panel shows is the code it saves.
//
// THE DELETE CONTROL APPEARS ONLY ON A CODED ROW. `ToolStore.remove` rewrites the
// persisted list, so a native id is still listed afterwards (registries.ts:43-50,
// :171-173); a control that cannot remove its own row would be a dead button. The
// plugin clears `chat.activeToolId` after a delete only when the id really left the
// registry (plugins/tools.ts, header note).
//
// Selection is written straight into `chat.activeToolId`: like `chat.sidebarTab`, the
// cell exists in contract.ts and has no `chat.tool.select` command id, and the core
// throws `unknown-command` for an unregistered one (ChatSidebar.tsx:15-22 records the
// same rule and the same workaround).
import type { ChangeEvent } from 'react';
import { isNativeTool, type ToolDefinition, type ToolLanguage } from '../../agents';
import {
    CHAT_ACTIVE_TOOL_STATE,
    CHAT_TOOL_CREATE_COMMAND,
    CHAT_TOOL_DELETE_COMMAND,
    CHAT_TOOL_SAVE_COMMAND,
    CHAT_TOOLS_STATE
} from '../contract';
import { useDashboardValue } from '../state-hooks';
import { useWorkbench } from '../workbench';
import { CloseIcon } from '../../icons';

/** Field copy. The panel lines are the oracle's, word for word (4786-4799). */
const COPY = {
    heading: 'Tools',
    newName: 'New tool',
    nameLabel: 'Tool name',
    languageLabel: 'Tool language',
    sourceLabel: 'Tool source',
    deleteTool: 'Delete tool',
    inspect: 'Inspect',
    nativeNote:
        'This tool is already available natively \u2014 the runtime provides it, so its implementation is not shown.',
    emptyRegistry: 'No tools registered.',
    emptyTitle: 'No tool selected',
    emptyBody: 'Pick a tool from the sidebar to inspect it here.'
} as const;

/** The two source languages `ToolDefinition` accepts (src/agents/index.ts:52). */
const TOOL_LANGUAGES: readonly { id: ToolLanguage; label: string }[] = [
    { id: 'javascript', label: 'JavaScript' },
    { id: 'typescript', label: 'TypeScript' }
];

/**
 * Row/panel label for a tool's kind, ported verbatim from the oracle (:551-555):
 * native entries read as platform-provided (no implementation shown), coded entries
 * carry their JavaScript/TypeScript tag. Exported so the test pins the exact strings.
 */
export const toolKindLabel = (tool: ToolDefinition): string =>
    tool.native ? 'Native \u2014 no implementation shown' : tool.language === 'javascript' ? 'JavaScript' : 'TypeScript';

export function ToolInspector() {
    const instance = useWorkbench();
    const tools = useDashboardValue<readonly ToolDefinition[]>(CHAT_TOOLS_STATE);
    const activeToolId = useDashboardValue<string | null>(CHAT_ACTIVE_TOOL_STATE);

    // A tool deleted from under this surface resolves to null, and the panel falls
    // back to the oracle's "No tool selected" state (:4796-4801).
    const tool = tools.find((candidate) => candidate.id === activeToolId) ?? null;

    /** Persist a patched definition; `id`/`native` are never patched (see header). */
    const update = (patch: Partial<Omit<ToolDefinition, 'id' | 'native'>>) => {
        if (tool === null) return;
        instance.execute<ToolDefinition, void>(CHAT_TOOL_SAVE_COMMAND, { ...tool, ...patch });
    };

    const selectTool = (id: string) => {
        instance.state<string | null>(CHAT_ACTIVE_TOOL_STATE).set(id);
    };

    const createTool = () => {
        // Fresh coded tool, appended, opened, rail switched to the Tool tab
        // (plugins/tools.ts).
        instance.execute<void, string>(CHAT_TOOL_CREATE_COMMAND);
    };

    const deleteTool = (id: string) => {
        instance.execute<string, void>(CHAT_TOOL_DELETE_COMMAND, id);
    };

    return (
        <div className="tools" data-testid="tool-surface">
            <div className="tools__head">
                <span className="tools__heading">{COPY.heading}</span>
                <span className="tools__count" data-testid="tool-count">
                    {tools.length}
                </span>
                <button
                    type="button"
                    className="btn btn--accent tools__new"
                    aria-label={COPY.newName}
                    title={COPY.newName}
                    data-testid="new-tool-button"
                    onClick={createTool}
                >
                    {COPY.newName}
                </button>
            </div>

            {tools.length === 0 ? (
                <p className="tools__empty" data-testid="tools-empty">
                    {COPY.emptyRegistry}
                </p>
            ) : (
                // Auto-fill tile grid (the oracle's `AgentToolGrid` layout idiom,
                // :800-810): the registry reads as a set of choices, and a row's
                // kind sits under its name exactly like the rail's meta line.
                <ul className="tools__grid" data-testid="tool-registry">
                    {tools.map((entry) => (
                        <li
                            key={entry.id}
                            className="tool"
                            data-selected={entry.id === activeToolId ? 'true' : 'false'}
                            // The kind rides on the row so the native badge stays a
                            // colour decision (tools.css reads `--warn` off this),
                            // never a string match against the label text.
                            data-native={isNativeTool(entry) ? 'true' : 'false'}
                            data-testid={`tool-row-${entry.id}`}
                        >
                            <button
                                type="button"
                                className="tool__pick"
                                aria-label={`${COPY.inspect} ${entry.name}`}
                                aria-current={entry.id === activeToolId ? 'true' : undefined}
                                data-selected={entry.id === activeToolId ? 'true' : 'false'}
                                data-testid={`tool-pick-${entry.id}`}
                                onClick={() => selectTool(entry.id)}
                            >
                                <span className="tool__name">{entry.name}</span>
                                <span className="tool__state">{toolKindLabel(entry)}</span>
                            </button>
                            {isNativeTool(entry) ? null : (
                                <button
                                    type="button"
                                    className="tool__remove"
                                    aria-label={COPY.deleteTool}
                                    title={COPY.deleteTool}
                                    data-testid={`tool-delete-${entry.id}`}
                                    onClick={() => deleteTool(entry.id)}
                                >
                                    <CloseIcon size={14} />
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            )}

            {tool === null ? (
                <div className="tools__none" data-testid="empty-tool-state">
                    <strong>{COPY.emptyTitle}</strong>
                    <span>{COPY.emptyBody}</span>
                </div>
            ) : (
                <section className="tools__panel" data-testid="tool-workspace">
                    {isNativeTool(tool) ? (
                        <>
                            {/* The oracle's read-only native panel (:4785-4791): name,
                                kind, and the note that replaces an implementation. */}
                            <strong className="tools__title">{tool.name}</strong>
                            <p className="tools__kind" data-testid={`tool-workspace-kind-${tool.id}`}>
                                {toolKindLabel(tool)}
                            </p>
                            <p className="tools__note" data-testid="tool-native-note">
                                {COPY.nativeNote}
                            </p>
                        </>
                    ) : (
                        <>
                            <input
                                className="field tools__field"
                                type="text"
                                value={tool.name}
                                placeholder={COPY.nameLabel}
                                aria-label={COPY.nameLabel}
                                data-testid="tool-name-input"
                                onChange={(event: ChangeEvent<HTMLInputElement>) => update({ name: event.target.value })}
                            />
                            <div className="tools__row">
                                <span className="tools__label">{COPY.languageLabel}</span>
                                <select
                                    className="field tools__select"
                                    // A coded tool without a stored language falls
                                    // back to the first accepted tag rather than
                                    // rendering an option the type rejects.
                                    value={tool.language ?? 'javascript'}
                                    aria-label={COPY.languageLabel}
                                    data-testid="tool-language-select"
                                    onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                                        update({ language: event.target.value as ToolLanguage })
                                    }
                                >
                                    {TOOL_LANGUAGES.map((language) => (
                                        <option key={language.id} value={language.id}>
                                            {language.label}
                                        </option>
                                    ))}
                                </select>
                                <span className="tools__kind" data-testid={`tool-workspace-kind-${tool.id}`}>
                                    {toolKindLabel(tool)}
                                </span>
                            </div>
                            {/* The source editor: `tools__source` is the mono panel the
                                oracle's `ToolCodeBlock` drew (:531-549), kept as the
                                editable surface so what the panel shows is what the
                                store persists. */}
                            <textarea
                                className="tools__source"
                                value={tool.code ?? ''}
                                placeholder="// tool implementation"
                                aria-label={COPY.sourceLabel}
                                rows={12}
                                spellCheck={false}
                                data-testid="tool-code"
                                onChange={(event: ChangeEvent<HTMLTextAreaElement>) => update({ code: event.target.value })}
                            />
                        </>
                    )}
                </section>
            )}
        </div>
    );
}
