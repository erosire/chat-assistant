// Storybook story for the public application shell (src/App.tsx) — T6 rewrite.
//
// WHY THE STORY NO LONGER RENDERS `<App />` BLIND: App is
// `<ChatAssistantApp />` at the DEPLOYMENT defaults, i.e. the LAN storage origin
// (http://192.168.50.109:5000) and the LAN provider origin (:5500) from
// src/api/config.ts. A story has to render anywhere — CI, an off-network laptop, a
// sandboxed iframe — so the canvas drives the SAME shell with the origins the
// component and plugin tests use (plugins/harness.ts:33-35): hosts that never
// resolve. Both mount reads (the tracked-conversation list in
// plugins/sessions.ts:354 and the model catalog in plugins/source.ts:838) then fail
// into the stage's non-modal error strip, which is a valid rendered state — nothing
// network-dependent is asserted. The station itself is composed locally, is
// viewport-locked, and renders synchronously: no request has to answer for the rail,
// the log, the composer or the inspector to appear.
//
// Wrapping follows the repo's dashboard-story idiom
// (WebstormDashboard.stories.tsx): Meta from @storybook/react with the component
// memo-wrapped for a viewport-sized surface, the single story via @library/test's
// asTestStory, and canvas-scoped queries through $screen.
import React from 'react';
import { Meta } from '@storybook/react';
import { $expect, $screen, asTestStory } from '@library/test';
import { styledComponent } from '@presource/react';
import { ChatAssistantApp } from './dashboard/ChatAssistantApp';

// The two non-resolving endpoints, spelled out rather than imported from
// plugins/harness.ts: that module pulls `vi` from vitest, and a story bundle has no
// business carrying the test runner.
const STORY_BASE_URL = 'http://storage.test/v1/chat-assistant/conversation';
const STORY_PROVIDER_URL = 'http://provider.test/providers/private/v1';

// Viewport-sized positioning context for the station. `.station` is 100dvh and
// overflow:hidden (styles/base.css:20-38) and index.html pins html/body/#root to
// height:100%, which the Storybook canvas does not — this surface fills the iframe
// edge to edge instead (same CSS as the FullScreen helper other dashboard stories
// import from @reloaded/headless, defined locally so this distribution keeps its
// dependency surface).
const StorySurface = styledComponent('div', {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%'
});

// Meta configuration — title mirrors the distribution/agent story hierarchy.
// layout:'fullscreen' removes the canvas padding so the viewport-locked station
// fills the iframe (the same parameter the other dashboard stories' decorators set).
const meta: Meta = {
    title: 'Distribution/Chat Assistant/App',
    // One story, one component: the shell. The only props are the two endpoints
    // above, which is what keeps the canvas off the real services.
    component: React.memo(() => (
        <StorySurface>
            <ChatAssistantApp baseUrl={STORY_BASE_URL} providerUrl={STORY_PROVIDER_URL} />
        </StorySurface>
    )),
    parameters: {
        layout: 'fullscreen'
    }
};

export default meta;

// Default story: the workstation. The play asserts only what is synchronous — the
// station frame, its three regions' owners and the brand line — before the mount
// reads settle. Outcomes that need a backend (catalog entries, restored chats, the
// failure banner) belong to the deployment, and are pinned against a doubled wire by
// src/dashboard/integration.test.tsx instead.
export const Default = asTestStory(async () => {
    // The shell mounts, and each region renders its real owner.
    await $screen.findByTestId('station-root');
    await $screen.findByTestId('sidebar');
    await $screen.findByTestId('transcript');
    await $screen.findByTestId('composer-input');
    // The bar's brand line is the station's own heading.
    await $expect.text('Chat Assistant');
});
