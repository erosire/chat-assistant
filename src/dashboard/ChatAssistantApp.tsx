// Public application shell of the rebuilt chat assistant.
//
// Same exported props shape as the pre-rebuild component it replaces
// ({ baseUrl?, providerUrl? }, see src/components/ChatAssistantApp.tsx), so
// src/App.tsx and any embedder keep working while the surface underneath becomes
// the plugin-composed workstation.
//
// Responsibilities (and nothing else):
//   1. resolve the deployment defaults from ../api (DEFAULT_CHAT_ASSISTANT_URL +
//      DEFAULT_PROVIDER_URL) — never hardcoded, and never a bare origin;
//   2. build ONE dashboard instance for this mount (composition.ts);
//   3. tear it down on unmount in the order the framework requires;
//   4. provide the instance through context and render the skin.
//
// Disposal ordering, the part that is easy to get wrong:
//
//   React unmounts bottom-up, so a child's useSyncExternalStore unsubscribe runs
//   BEFORE this component's own effect cleanup. Deferring dispose() one microtask
//   past that cleanup adds the second half of the guarantee and, more
//   importantly, survives React 18 StrictMode: StrictMode runs
//   setup -> cleanup -> setup for the same committed tree, and the re-run setups
//   are again child-first. A synchronous dispose() in the cleanup would therefore
//   leave the children re-subscribing to detached state cells, and a detached
//   cell throws DashboardError('disposed') on get()/subscribe() (see
//   packages/underload/dashboard/src/extensions/state.ts). The deferred dispose is
//   cancelled by the second setup, so the instance simply stays alive; on a real
//   unmount no setup follows, and the microtask disposes exactly once.
//
// The instance is built once per mount: changing baseUrl/providerUrl after mount
// does not rebuild it (an embedder remounts by keying this component instead),
// because rebuilding would drop every state cell mid-session.
import { memo, useEffect, useRef } from 'react';
import type { Dashboard } from '@underload/dashboard';
// The vendored workstation skin travels WITH this export (R15). The pre-rebuild
// component self-styled through Emotion (`styledComponent`), so an embedder that
// imported `ChatAssistantApp` got a styled station with no setup; the rebuild
// styles through plain CSS files instead, and only src/main.tsx imported them —
// which left every consumer of the export rendering an unstyled DOM tree. A
// side-effect import here is the exact equivalent of the old Emotion wiring: Vite
// dedupes the module, so the build still emits ONE CSS asset (verified with
// `vite build`), and the app entry keeps its own import for the standalone
// bundle (src/main.tsx).
import './styles/index.css';
// Deployment defaults, single source of truth. NOT the bare origins in
// ../api/config.ts: the public props mean the FULL endpoints (see the type below),
// which is what composition.ts resolves and what both api clients expect
// (api/chat-assistant.ts appends '/{conversationId}' to `baseUrl`, and
// api/provider.ts derives '{base}/models' and '{base}/chat/completions' from ITS
// base). Composition and options agree on these same two constants
// (composition.ts:80-86, plugins/options.ts:53-54).
import { DEFAULT_CHAT_ASSISTANT_URL } from '../api/chat-assistant';
import { DEFAULT_PROVIDER_URL } from '../api/provider';
import { createChatDashboard } from './composition';
import { WorkstationShell } from './WorkstationShell';
import { WorkbenchProvider } from './workbench';

export type ChatAssistantAppProps = {
    /**
     * Conversation-storage ENDPOINT. Defaults to DEFAULT_CHAT_ASSISTANT_URL
     * ('{origin}/v1/chat-assistant/conversation', api/chat-assistant.ts:16) — the
     * exact value the pre-rebuild `baseUrl` prop meant
     * (components/ChatAssistantApp.tsx:2443). A bare origin is wrong here: the
     * storage client would repoint every conversation route at the storage root.
     */
    baseUrl?: string;
    /**
     * Inference-provider BASE for ONLINE mode. Defaults to DEFAULT_PROVIDER_URL
     * ('{origin}/providers/private/v1', api/provider.ts:26) — the pre-rebuild
     * `providerUrl` meaning. It is NOT derived from `baseUrl`: the provider listens
     * on its own host/port (api/config.ts), and the catalog and completions routes
     * are read relative to this base.
     */
    providerUrl?: string;
};

export const ChatAssistantApp = memo(function ChatAssistantApp({
    baseUrl = DEFAULT_CHAT_ASSISTANT_URL,
    providerUrl = DEFAULT_PROVIDER_URL
}: ChatAssistantAppProps = {}) {
    // Built during the first render (not in an effect) so the very first commit
    // already has a live instance: a dashboard is synchronous by contract, and
    // deferring it would mean a render pass with no shell. The ref write is
    // idempotent, which is what keeps StrictMode's double render from leaking a
    // second instance.
    const instanceRef = useRef<Dashboard | null>(null);
    if (instanceRef.current === null) {
        instanceRef.current = createChatDashboard({ baseUrl, providerUrl });
    }
    const instance = instanceRef.current;

    // Cancel handle for the dispose scheduled by the previous cleanup, if any.
    const cancelDisposeRef = useRef<(() => void) | null>(null);

    useEffect(() => {
        // A remount (StrictMode, Fast Refresh) re-entering this setup means the
        // tree is still live: retract the pending teardown.
        const cancel = cancelDisposeRef.current;
        if (cancel !== null) {
            cancelDisposeRef.current = null;
            cancel();
        }

        return () => {
            // Children have already unsubscribed (bottom-up unmount), so nothing
            // in the tree can observe this dispose; the microtask only exists so
            // a StrictMode re-setup can still cancel it.
            let cancelled = false;
            cancelDisposeRef.current = () => {
                cancelled = true;
            };
            queueMicrotask(() => {
                if (cancelled) {
                    return;
                }
                cancelDisposeRef.current = null;
                // dispose() is idempotent and collects its own cleanup failures;
                // a teardown error must never surface as an unhandled rejection.
                try {
                    instance.dispose();
                } catch {
                    // cleanup-failed: the dashboard is disposed regardless. The
                    // chat transports own their teardown diagnostics.
                }
            });
        };
    }, [instance]);

    return (
        <WorkbenchProvider instance={instance}>
            {/* The shell takes no props here: it reads brand, regions, slots and
                the three skin cells out of the instance through context. */}
            <WorkstationShell />
        </WorkbenchProvider>
    );
});
