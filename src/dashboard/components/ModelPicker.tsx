// ModelPicker — the [Agents][Model] picker line above the composer input.
//
// THE INVISIBLE-NATIVE-SELECT PATTERN (behavior oracle,
// src/components/ChatAssistantApp.tsx:5093-5167): each picker is a quiet
// clickable TEXT line with the real native <select> overlaid on top of it at
// `opacity: 0`. The text line is what the operator reads; the select is what the
// browser opens and what `fireEvent.change(...)` drives in tests. Two rules the
// oracle learned the hard way are preserved here:
//
//   1. EACH pair is its own positioning context (`.composer__pick`), so an
//      overlay covers ONLY its own label — a shared row-wide overlay let the
//      model select cover the agent text and eat every click, making agent
//      selection impossible (oracle 5099-5103);
//   2. the option VALUES stay the full provider-routed ids while only the
//      LABELS are shortened, because the provider routes by id (oracle
//      1744-1783 `modelLabel` / `uniqueModelLabels`).
//
// LABEL SOURCES: `chat.models` is the catalog of ids (the state cell the core
// worker publishes) and `chat.provider.labels()` returns the "base (provider)"
// display strings INDEX-ALIGNED with `chat.provider.catalog()`. `labels()` is
// async, so the resolved list lives in component state; until it lands, and for
// any id missing from it (a historical `ChatMessage.model` outside the current
// catalog), the label falls back to the locally stripped name — exactly the
// oracle's `modelLabels.get(id) ?? modelLabel(id)` lookup (oracle 2117, 4342).
//
// THE RENDER SOURCE of each picker is the cell its own command WRITES: model from
// `chat.model` via `chat.model.set`, agent from `chat.agent` via `chat.agent.set`.
// `chat.activeAgentId` is the Agents-tab editor's selection and must never show up
// in the composer, or the strip displays a choice the next send will not make.
//
// The strip is presentational-but-wired: it reads `chat.model`/`chat.agent`
// cells and mutates through `chat.model.set` / `chat.agent.set` only.
import { useCallback, useEffect, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { AgentDefinition } from '../../agents';
import {
    CHAT_AGENT_SET_COMMAND,
    CHAT_AGENT_STATE,
    CHAT_AGENTS_STATE,
    CHAT_MODEL_SET_COMMAND,
    CHAT_MODEL_STATE,
    CHAT_MODELS_STATE,
    CHAT_PROVIDER_SERVICE
} from '../contract';
import { useDashboardValue } from '../state-hooks';
import { useWorkbench } from '../workbench';

/** The slice of `chat.provider` this module needs (ProviderClient in services). */
export type ProviderLabelService = {
    catalog(): Promise<string[]>;
    labels(): Promise<string[]>;
};

/**
 * Strip the organisation/provider prefix for display: "zai-org/GLM-5.2-NVFP4"
 * reads "GLM-5.2-NVFP4". Local port of the oracle's `modelLabel`
 * (ChatAssistantApp.tsx:1748-1751) — the split point is the FINAL slash. Kept
 * local on purpose: importing the pre-rebuild component for one helper would pull
 * the whole Emotion tree into the new bundle.
 */
export const modelLabel = (id: string): string => {
    const slash = id.lastIndexOf('/');
    return slash >= 0 ? id.slice(slash + 1) : id;
};

// One in-flight `labels()` resolution per service object. Without this cache
// every mount of ModelPicker/MessageTurn would re-request the catalog; the
// WeakMap drops the entry with the instance when the dashboard is disposed.
const labelPromises = new WeakMap<object, Promise<string[]>>();
const resolveLabels = (service: ProviderLabelService): Promise<string[]> => {
    const cached = labelPromises.get(service);
    if (cached !== undefined) return cached;
    const promise = service.labels().catch(() => [] as string[]);
    labelPromises.set(service, promise);
    return promise;
};

/**
 * id → display label for the current catalog, index-aligned with
 * `chat.models`. `labelFor` degrades to the stripped name for unknown ids, and
 * to the empty string for the empty id (no model selected).
 */
export function useModelLabels(): { labelFor: (id: string) => string; ready: boolean } {
    const models = useDashboardValue<readonly string[]>(CHAT_MODELS_STATE);
    const service = useWorkbenchService();

    const [labels, setLabels] = useState<readonly string[]>([]);

    useEffect(() => {
        if (service === null) return;
        let alive = true;
        resolveLabels(service).then((next) => {
            // Stale-write guard: only the mount that still owns the effect may
            // publish the resolved labels.
            if (alive) setLabels(next);
        });
        return () => {
            alive = false;
        };
    }, [service]);

    const labelFor = useCallback(
        (id: string): string => {
            if (id === '') return '';
            const index = models.indexOf(id);
            // Index alignment with the catalog is the contract; a miss (the id
            // was dropped from the provider, or it is a historical turn's model)
            // falls back to the stripped name.
            const aligned = index >= 0 ? labels[index] : undefined;
            return aligned ?? modelLabel(id);
        },
        [models, labels]
    );

    return { labelFor, ready: labels.length > 0 };
}

/** `chat.provider` is optional at render time: a stub composition may omit it. */
function useWorkbenchService(): ProviderLabelService | null {
    const instance = useWorkbench();
    return (() => {
        try {
            return instance.service<ProviderLabelService>(CHAT_PROVIDER_SERVICE);
        } catch {
            // `unknown-service` — a composition without the provider plugin
            // (harnesses, the settings surface) still renders the picker, it
            // just labels from the ids.
            return null;
        }
    })();
}

// ——— one picker = text line + overlaid invisible select ——————————————————————

export type PickerOption = { value: string; label: string };

export type PickerFieldProps = {
    /** The visible text line (the selected option's display label). */
    text: string;
    options: readonly PickerOption[];
    value: string;
    onChange: (value: string) => void;
    /** Accessible name of the native select ("Select model"/"Select agent"). */
    ariaLabel: string;
    testId: string;
    /** testid of the visible text line, e.g. "model-label"/"agent-label". */
    textTestId: string;
    /** A picker with nothing to choose is inert, exactly like the oracle's. */
    disabled?: boolean;
};

/**
 * One picker pair. `.composer__pick` is the positioning context; the select is
 * absolutely positioned over the text at opacity 0 (composer.css), so the label
 * is the paint and the select is the interaction.
 */
export function PickerField({
    text,
    options,
    value,
    onChange,
    ariaLabel,
    testId,
    textTestId,
    disabled = false
}: PickerFieldProps) {
    const handleChange = (event: ChangeEvent<HTMLSelectElement>) => onChange(event.target.value);

    return (
        <div className="composer__pick">
            <span className="composer__pick-text" data-testid={textTestId} title={text}>
                {text}
            </span>
            <select
                className="composer__pick-select"
                value={value}
                onChange={handleChange}
                aria-label={ariaLabel}
                // A <select> with no options has no accessible value, so it is
                // disabled instead (oracle 5155).
                disabled={disabled}
                data-testid={testId}
            >
                {options.map((option) => (
                    <option key={`${option.value || 'none'}`} value={option.value}>
                        {option.label}
                    </option>
                ))}
            </select>
        </div>
    );
}

// ——— the wired picker strip —————————————————————————————————————————————————

/**
 * The composer's picker ROW: agent on the LEFT, model on the RIGHT (oracle
 * 5093-5168). "None" ('' value) is the agent DEFAULT — no agent applies — and
 * picking an agent replaces the chat's own system prompt block with the agent's
 * block, which is why the choice is a command rather than local state.
 */
export function ModelPicker() {
    const instance = useWorkbench();
    const models = useDashboardValue<readonly string[]>(CHAT_MODELS_STATE);
    const model = useDashboardValue<string>(CHAT_MODEL_STATE);
    const agents = useDashboardValue<readonly AgentDefinition[]>(CHAT_AGENTS_STATE);
    // THE COMPOSER PICKER RENDERS THE CELL IT WRITES. `chat.agent` is the agent that
    // prefixes new chats and is what `chat.agent.set` (the onChange below) mutates;
    // `chat.activeAgentId` is the AGENTS-TAB editor's selection, owned by
    // `chat.agent.create` / the rail's rows. Reading the editor cell here made the
    // two halves disagree: a pick applied an agent while the select still showed
    // "None", and opening an agent in the rail silently changed the composer's
    // DISPLAY without applying it. The oracle had one cell for this (`agentChoice`,
    // ChatAssistantApp.tsx:2516) and only ever displayed what it sent.
    const appliedAgentId = useDashboardValue<string>(CHAT_AGENT_STATE);
    const { labelFor } = useModelLabels();

    // A recorded/selected model missing from the catalog stays selectable, so an
    // older conversation remains usable with its historical model (oracle
    // 4327-4331: `chosenModel && !catalog.includes(it) ? [it, ...catalog] : catalog`).
    const optionIds = model !== '' && !models.includes(model) ? [model, ...models] : [...models];
    const modelOptions: PickerOption[] = optionIds.map((id) => ({ value: id, label: labelFor(id) }));
    // An empty catalog still gets ONE option (oracle 5157-5158): a <select> with no
    // options has no accessible value at all, so the row would read as blank.
    const modelRows: readonly PickerOption[] =
        modelOptions.length === 0 ? [{ value: '', label: 'No models available' }] : modelOptions;

    const agentOptions: PickerOption[] = [
        { value: '', label: 'None' },
        ...agents.map((agent) => ({ value: agent.id, label: agent.name }))
    ];
    // `?? ''` only guards a host that registers the cell with a null seed; the
    // production core registers a string ('' = no agent applies).
    const chosenAgentId = appliedAgentId ?? '';
    const agentText = agents.find((agent) => agent.id === chosenAgentId)?.name ?? 'None';

    const modelText =
        model !== ''
            ? labelFor(model)
            : models.length === 0
              ? 'No models available'
              : 'Select model';

    return (
        <div className="composer__row" data-testid="model-picker">
            <PickerField
                text={agentText}
                options={agentOptions}
                value={chosenAgentId}
                textTestId="agent-label"
                testId="agent-select"
                ariaLabel="Select agent"
                onChange={(next) => instance.execute<string>(CHAT_AGENT_SET_COMMAND, next)}
            />
            <PickerField
                text={modelText}
                options={modelRows}
                value={model}
                textTestId="model-label"
                testId="model-select"
                ariaLabel="Select model"
                disabled={modelOptions.length === 0}
                onChange={(next) => instance.execute<string>(CHAT_MODEL_SET_COMMAND, next)}
            />
        </div>
    );
}
