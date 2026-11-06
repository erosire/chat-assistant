// Plugin barrel for the vendored workstation skin.
//
// One import path for composition.ts (and for any later task composing a variant
// dashboard). Every entry is a factory returning a plain `DashboardPlugin`:
// nothing here is registered implicitly — composition.ts and plugins/extras.ts
// decide the graph.
//
// REACT: the two skin plugins are plain data modules, and every headless chat
// plugin stays React-free EXCEPT `./surfaces`, which contributes the visible
// components through the region slots. That is the only place the plugin layer is
// allowed to import a component, and it is why composition order is testable
// without a DOM.
export { createLayoutPlugin } from './layout';
export { createThemePlugin } from './theme';
// T3's chat graph. `createChatPlugins` is the whole set in dependency order; the
// individual factories are exported for a variant dashboard that wants only part of it.
export { chatPlugins, createChatPlugins } from './chat';
export { createCorePlugin } from './core';
export { createSourcePlugin } from './source';
export { createSessionsPlugin } from './sessions';
export { createTranscriptPlugin } from './transcript';
export { createSystemPromptPlugin } from './system-prompt';
// The add-on capabilities (plugins/extras.ts is the ordered list composition.ts
// appends). Each factory is exported separately so a build can pick a subset —
// e.g. a headless composition that registers everything except `./surfaces`.
export { createAgentsPlugin, AGENTS_PLUGIN_ID } from './agents';
export { createToolsPlugin, TOOLS_PLUGIN_ID } from './tools';
export { createSettingsPlugin } from './settings';
export { createVoicePlugin, type VoicePluginOptions } from './voice';
export { createNoticesPlugin, type NoticesPluginOptions } from './notices';
export { createInputsPlugin, INPUTS_PLUGIN_ID } from './inputs';
export { createSurfacesPlugin, SURFACES_PLUGIN_ID } from './surfaces';
// The open extension point: the ordered add-on list itself.
export { EXTRA_PLUGINS } from './extras';
export { describeChatOptions, type ChatConfig, type ChatPluginOptions } from './options';
