// Public barrel for the rebuilt (plugin-composed) chat assistant UI.
//
// src/index.ts — the distribution's public barrel — now re-exports THIS
// ChatAssistantApp (the pre-rebuild src/components/ monolith is retired), so there
// is exactly one `ChatAssistantApp` in the package and nothing is exported twice.
// What is exported below is the whole station plus the seams a host needs to build
// a variant one: the skin, the composition root, the React bridge, and the full id
// vocabulary from ./contract.
export { ChatAssistantApp } from './ChatAssistantApp';
export type { ChatAssistantAppProps } from './ChatAssistantApp';
export { WorkstationShell } from './WorkstationShell';
export { WorkbenchProvider, useWorkbench } from './workbench';
export {
    useDashboardPair,
    useDashboardService,
    useDashboardSlot,
    useDashboardState,
    useDashboardValue
} from './state-hooks';
export { createChatDashboard } from './composition';
export type { ChatDashboardOptions } from './composition';
// The plugin factories, for a host that composes a variant station (a headless
// build without ./plugins/surfaces, a voice surface with an injected speech
// client). `chatPlugins` is the T3 set at the deployment defaults and
// `EXTRA_PLUGINS` is the ordered add-on set composition.ts appends.
export {
    chatPlugins,
    createAgentsPlugin,
    createChatPlugins,
    createInputsPlugin,
    createLayoutPlugin,
    createNoticesPlugin,
    createSettingsPlugin,
    createSurfacesPlugin,
    createThemePlugin,
    createToolsPlugin,
    createVoicePlugin,
    EXTRA_PLUGINS
} from './plugins';
// The full id + type vocabulary (state/service/command/event/slot ids, view
// types, panel shapes) the whole UI is written against.
export * from './contract';
