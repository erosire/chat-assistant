// Public application shell. The component stays intentionally small so the
// reusable dashboard remains available through src/dashboard/index.ts.
//
// T6 retired the pre-rebuild monolith (src/components/, 5,090 lines): this entry
// renders the plugin-composed workstation, and src/index.ts exports THIS
// ChatAssistantApp under the same name and with the same props, so an embedder's
// import site is unchanged. App itself takes no props: the deployment defaults are
// resolved inside ChatAssistantApp (src/dashboard/ChatAssistantApp.tsx).
import { ChatAssistantApp } from './dashboard/ChatAssistantApp';

// Render the default chat assistant experience: the deployment defaults in
// src/api/config.ts are resolved inside ChatAssistantApp, so App takes no props.
export function App() {
    return <ChatAssistantApp />;
}
