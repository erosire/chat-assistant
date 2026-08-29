// Storybook stories for the public application shell (src/App.tsx).
//
// No mocks, no fixtures: App renders exactly as deployed and talks to the
// REAL backends through the defaults in src/api (DEFAULT_CHAT_ASSISTANT_URL →
// DATABASE_API_HOST:DATABASE_API_PORT and DEFAULT_PROVIDER_URL →
// INFERENCE_PROVIDER_HOST:INFERENCE_PROVIDER_PORT in src/api/config.ts), so
// the canvas exercises the actual storage service and model provider. Nothing
// network-dependent is asserted — the plays only
// verify the shell LOADS: the root surface, fallback header title, and
// composer all render synchronously, before the mount effects' catalog GET
// (fetchProviderModels) and history GET (listConversations) settle. An
// unreachable backend is also a valid rendered state — both mount effects
// catch failures into the non-modal ErrorBanner
// (components/ChatAssistantApp.tsx:1767-1769 and 1788-1790), never into an
// unhandled rejection or a blank page.
// Wrapping follows the repo's dashboard-story idiom
// (WebstormDashboard.stories.tsx): Meta from @storybook/react with the
// component memo-wrapped for a viewport-sized surface, stories via
// @library/test's asTestStory, canvas-scoped queries through $screen.
import React from 'react';
import { Meta } from '@storybook/react';
import { $expect, $screen, asTestStory } from '@library/test';
import { styledComponent } from '@presource/react';
import { App } from './App';

// Viewport-sized positioning context for the app shell. The shell's Page
// (components/ChatAssistantApp.tsx:200) locks itself to height:100% of its
// parent; in a regular document that parent is #root (index.html pins
// html/body/#root to height:100%), but the Storybook canvas has no such
// rule — this surface fills the canvas iframe instead (same CSS as the
// FullScreen helper other dashboard stories import from @react/headless,
// defined locally so this distribution keeps its dependency surface).
const StorySurface = styledComponent('div', {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%'
});

// Meta configuration — title mirrors the distribution/agent story hierarchy.
// layout:'fullscreen' removes the canvas padding so the viewport-locked shell
// fills the iframe edge to edge (same parameter the dashboard stories' surface
// decorators achieve).
const meta: Meta = {
    title: 'Distribution/Chat Assistant/App',
    // App takes no props: it always connects to the actual services via the
    // src/api deployment defaults. The memo wrapper only supplies the
    // viewport-sized surface the locked Page requires (see StorySurface).
    component: React.memo(() => (
        <StorySurface>
            <App />
        </StorySurface>
    )),
    parameters: {
        layout: 'fullscreen'
    }
};

export default meta;

// Default story: the live dashboard. Sidebar history, the model catalog, and
// chat streaming all round-trip to the real services; with nothing selected
// the empty state and composer show. The play asserts only the synchronous
// shell — network outcomes (catalog entries, restored chats, error banner)
// belong to the deployment, not to this story. Every query/assertion is
// awaited: findByTestId polls until the element mounts, and $expect.text
// validates visibility through the shared kit ($dom.text().isValid()).
export const Default = asTestStory(async () => {
    // Root surface mounts.
    await $screen.findByTestId('chat-assistant');
    // The composer renders regardless of the catalog request's state.
    await $screen.findByTestId('chat-input');
    await $screen.findByTestId('model-select');
    // With no chat selected the header keeps the product-name fallback.
    await $expect.text('Chat Assistant');
});
