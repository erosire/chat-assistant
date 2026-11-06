// Chat INPUTS plugin: the two composer-facing commands that are pure cell writes.
//
// WHY THIS PLUGIN EXISTS (T6): `chat.draft.set` and `chat.model.set` are in the
// frozen contract (../contract.ts:463-464 — `string -> void` each) and
// components/ComposerDeck.tsx:127 + components/ModelPicker.tsx:248 execute them on
// every keystroke and every model pick, but NO chat plugin registered them: the T3
// set (plugins/chat.ts) owns the flows, and every add-on worker left these two to
// the composition seam. Unregistered is not inert — `execute` throws
// `unknown-command` (packages/underload/dashboard/src/extensions/registries.ts:77),
// so typing in the composer and picking a model both failed in the assembled app.
//
// WHY A PLAIN CELL WRITE IS THE WHOLE IMPLEMENTATION: state is truth in this graph,
// and the consequences of these two cells changing are already subscriptions owned
// by the plugins that read them —
//   chat.draft     -> nothing else has to react; ChatStage's follow effect treats a
//                     draft change as an EXPLICIT pin signal (components/ChatStage.tsx:
//                     108-118 `isExplicitFollowSignal`), which is exactly what a typed
//                     character should do (oracle 5175-5178 grew the field and scrolled
//                     on the same keystroke).
//   chat.model     -> plugins/source.ts:830-832 subscribes `cells.model` and re-writes
//                     MODEL_STORAGE_KEY (`chat-assistant:model`) on every real change,
//                     which is the oracle's `model(value) + rememberModel(value)` pair
//                     (monolith :5141-5145). Registering the write here rather than
//                     persisting here keeps ONE persistence path for every way the
//                     model moves (catalog adoption, a selected record's model, a
//                     completed turn, this command).
//
// NO EPOCH GUARD, NO ACTIVITY SLOT: both are synchronous, local and cancellation is
// meaningless (the in-flight request already holds its own model snapshot — the
// oracle's `chosenModel` capture at monolith :3881).
import type { DashboardPlugin } from '@underload/dashboard';
import {
    CHAT_CELLS_SERVICE,
    CHAT_DRAFT_SET_COMMAND,
    CHAT_MODEL_SET_COMMAND,
    PLUGIN_IDS,
    type ChatCells
} from '../contract';

/**
 * Plugin id. Like the agents/tools add-ons (plugins/agents.ts:51,
 * plugins/tools.ts:46) the add-on seam declares its own id: `PLUGIN_IDS` was
 * frozen by T1 and carries no inputs entry, and the id follows the same `chat.*`
 * vocabulary as the plugins it sits after.
 */
export const INPUTS_PLUGIN_ID = 'chat.inputs';

/**
 * Build the inputs plugin for one dashboard.
 * No options: neither command has configuration.
 */
export function createInputsPlugin(): DashboardPlugin {
    return {
        id: INPUTS_PLUGIN_ID,
        // The cells handle is resolved DURING setup, so the edge is what makes the
        // lookup defined rather than a lucky coincidence (`requires` orders, it does
        // not validate — see composition.ts:9-16).
        requires: [PLUGIN_IDS.chatCore],
        setup(api) {
            const cells = api.getService<ChatCells>(CHAT_CELLS_SERVICE);

            /**
             * `chat.draft.set` — the composer's value, verbatim.
             * NO trim: the oracle holds the raw typed string in state (monolith
             * :2517, and the send flow trims at submit time in plugins/source.ts:429),
             * so trailing spaces a writer typed survive to the next render instead of
             * jumping the caret. A non-string payload (an untyped caller) degrades to
             * the empty composer rather than throwing.
             */
            api.command<string, void>(CHAT_DRAFT_SET_COMMAND, (value) => {
                const next = typeof value === 'string' ? value : '';
                // SameValueZero on the cell's own value: an equal write notifies
                // nobody, so a re-typed identical value costs React nothing.
                if (next === cells.draft.get()) return;
                cells.draft.set(next);
            });

            /**
             * `chat.model.set` — the picker's value, verbatim.
             * NOT validated against `chat.models`: the oracle assigns whatever the
             * select answers, and three legitimate writers are outside the catalog
             * (a remembered model with an unreachable catalog, monolith :2741-2743; a
             * selected record's own model, :3172-3174; a fork record's model, :3722).
             * A blank id is legal too — it is what an empty catalog selects, and
             * `send()` refuses it (:436) rather than the setter inventing a default.
             */
            api.command<string, void>(CHAT_MODEL_SET_COMMAND, (value) => {
                const next = typeof value === 'string' ? value : '';
                if (next === cells.model.get()) return;
                // The write is the persistence: source.ts's subscription re-covers
                // MODEL_STORAGE_KEY for exactly this change.
                cells.model.set(next);
            });

            // Nothing to tear down: no subscription is opened and no timer runs here.
        }
    };
}

/** The inputs plugin (stateless, so one instance is reusable across builds). */
export const inputsPlugin: DashboardPlugin = createInputsPlugin();
