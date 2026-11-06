/**
 * SMOKE test for the public application shell (src/App.tsx) — T6 rewrite.
 *
 * WHAT THIS REPLACES: the pre-rebuild version delegated to
 * `storybookTestRunner(stories)` and asserted `data-testid="chat-assistant"`, a
 * testid of the retired monolith. Stories are no longer the execution vehicle for
 * the entry point (the component suite covers the surfaces and
 * src/dashboard/integration.test.tsx covers the graph); what is left to prove here
 * is that the shipped ENTRY renders the workstation: the station mounts, the three
 * regions show the REAL surfaces, and nothing placeholder-shaped survives.
 *
 * WHY `fetch` IS DOUBLED: App renders ChatAssistantApp with the deployment defaults
 * (src/api/config.ts pins the LAN storage + provider origins), and the composed
 * graph fires two reads one microtask after setup — the tracked-conversation list
 * and the model catalog (plugins/sessions.ts:354, plugins/source.ts:838). In this
 * environment those hosts are unreachable, so every route is answered locally and
 * the assertions stay about RENDERING, not about the network. An unrouted request
 * throws (plugins/harness.ts:121), which is what makes the double load-bearing
 * rather than decorative.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { installFetch, jsonResponse, resetStorage, seedSettings } from './dashboard/plugins/harness';

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

/** The two mount reads, answered for whichever deployment origins App defaults to. */
const stubDeploymentReads = () =>
    installFetch([
        {
            match: (url) => url.endsWith('/models'),
            reply: () => jsonResponse(200, { object: 'list', data: [] })
        },
        {
            match: () => true,
            reply: () => jsonResponse(200, { conversations: [] })
        }
    ]);

describe('App (public shell)', () => {
    it('mounts the station with its real surfaces and no placeholder chrome', () => {
        resetStorage();
        seedSettings('online', '');
        stubDeploymentReads();

        const { container } = render(<App />);
        const station = screen.getByTestId('station-root');

        // The shell: the viewport-locked station root and its three region columns.
        expect(station.className).toBe('station');
        expect(station.getAttribute('data-theme')).toBe('ink');
        expect(screen.getByTestId('station-bar').textContent).toContain('Chat Assistant');
        expect(document.querySelectorAll('.station__region')).toHaveLength(3);

        // The four grammar ids the rebuild was accepted on (the data-testid grammar in
        // src/dashboard/contract.ts:21-46): `sidebar` (ChatSidebar), `transcript`
        // (TranscriptStream), `composer-input` (ComposerDeck) and `aside-panel`
        // (ChatInspector). Each one only exists if its region's contribution won, so
        // this is the assertion that the station renders REAL surfaces.
        expect(screen.getByTestId('sidebar')).toBeTruthy();
        expect(screen.getByTestId('transcript')).toBeTruthy();
        expect(screen.getByTestId('composer-input')).toBeTruthy();
        expect(screen.getByTestId('aside-panel')).toBeTruthy();
        // The conversation tab has no inspector, and that is a rendered state, not an
        // empty column (src/dashboard/components/ChatInspector.tsx).
        expect(screen.getByTestId('inspector-idle')).toBeTruthy();

        // Nothing placeholder-shaped survives the swap. T3's Placeholder{Stage,Sidebar,
        // Aside} components are deleted, and T1's order-0 layout DESCRIPTORS never
        // render now that every channel has an owner — their signature is the
        // `placeholder` hint line inside a panel head.
        expect(screen.queryByText('placeholder')).toBeNull();
        expect(container.querySelectorAll('.station__region--sidebar .panel')).toHaveLength(0);
        expect(container.querySelectorAll('.station__region--stage .panel')).toHaveLength(0);

        // The stage's transient strip owns `notice-strip` and is absent on an empty
        // feed; the error strip belongs to the stage alone, so a clean mount claims
        // neither (the "no two components may both render `error-banner`" rule).
        expect(screen.queryByTestId('notice-strip')).toBeNull();
        expect(screen.queryAllByTestId('error-banner')).toHaveLength(0);
    });

    it('carries the skin with the public export, not only with the app entry', () => {
        // B2 / R15: the pre-rebuild component styled ITSELF (Emotion `styledComponent`),
        // so importing `ChatAssistantApp` was enough for an embedder to get a styled
        // station. The rebuild styles through plain CSS files and only src/main.tsx
        // imported them, which left every consumer of the public export rendering an
        // unstyled DOM tree. The side-effect import therefore lives in the component
        // module, and this is the assertion that keeps it there.
        //
        // Why a source check rather than a render check: Vitest stubs every CSS request
        // (the default `test.css: false`), so no test in this suite can observe a
        // stylesheet at all. The observable half of the same rule is `vite build`
        // emitting exactly ONE CSS asset despite the two importers — verified as part of
        // the acceptance gates.
        const component = readFileSync(join(__dirname, 'dashboard', 'ChatAssistantApp.tsx'), 'utf-8');
        expect(component).toContain("import './styles/index.css';");

        // The standalone entry keeps naming the stylesheet explicitly, and the
        // duplication is of an import, never of the file itself.
        const entry = readFileSync(join(__dirname, 'main.tsx'), 'utf-8');
        expect(entry).toContain("import './dashboard/styles/index.css';");
    });
});
