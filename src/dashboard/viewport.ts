// Viewport seam: the one place the chat surface asks "how wide is this window?".
//
// `useViewport()` is the reactive half of that question and `chat.drawerOpen` is
// the state it drives: the sidebar is an off-canvas drawer on a narrow viewport and
// a permanent column on a wide one, so a crossing to DESKTOP must retract the
// drawer — otherwise the operator widens the window and the drawer's open flag
// keeps an invisible overlay latched on (the oracle tracked the same thing with a
// plain `sidebarOpen(false)` written by every action that closed it,
// components/ChatAssistantApp.tsx:3323-3325, :3493).
//
// THE THRESHOLD IS 900px. It is the oracle's md gate (its Enter-to-send rule,
// :2404-2410) and the value the T3 brief pins, so the drawer and the desktop
// keyboard share one number. The skin agrees: styles/base.css drops the station
// grid to a single column at `max-width: 899px` (base.css:397), i.e. the exact
// complement of `(min-width: 900px)`, and the per-area files that reflow an
// element inside a region use the same 899 (composer.css:242, sessions.css:336,
// notices.css:129, settings.css:221). There is therefore no range in which the
// seam reports 'desktop' while the CSS still paints the narrow layout.
//
// ENVIRONMENT FALLBACK: jsdom implements no `matchMedia`, and a locked-down browser
// may omit it entirely. A missing (or throwing) API answers DESKTOP — the documented
// browser default, the same degradation `prefers()` follows in plugins/theme.ts:41-50
// — and a no-preference SSR pass resolves identically, so there is no hydration
// flip. A plugin/view that threw here would take the whole surface down.
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { CHAT_DRAWER_OPEN_STATE, type ViewportMode } from './contract';
import { useWorkbench } from './workbench';

/** The desktop breakpoint, as a media query string (exported for tests). */
export const DESKTOP_QUERY = '(min-width: 900px)';

/** MatchMedia probe with the fallbacks every host environment needs. */
export const isDesktopViewport = (): boolean => {
    try {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
            return true;
        }
        return window.matchMedia(DESKTOP_QUERY).matches === true;
    } catch {
        // jsdom's stub can throw outright; "no information" still means desktop.
        return true;
    }
};

/**
 * Subscribe to the desktop query. The listener is attached with
 * `addEventListener('change')` and falls back to the Safari-13 `addListener`
 * spelling; with neither (jsdom) the subscription is a no-op and the snapshot
 * simply never changes on its own, which is what keeps the store contract intact.
 */
const subscribeViewport = (onChange: () => void): (() => void) => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return () => {};
    }
    let query: MediaQueryList;
    try {
        query = window.matchMedia(DESKTOP_QUERY);
    } catch {
        return () => {};
    }
    if (typeof query.addEventListener === 'function') {
        query.addEventListener('change', onChange);
        return () => query.removeEventListener('change', onChange);
    }
    const legacy = query as MediaQueryList & {
        addListener?: (listener: () => void) => void;
        removeListener?: (listener: () => void) => void;
    };
    legacy.addListener?.(onChange);
    return () => legacy.removeListener?.(onChange);
};

/** Reactive viewport class: 'desktop' at/above 900px, 'mobile' below it. */
export function useViewportSnapshot(): ViewportMode {
    const getSnapshot = useCallback(() => (isDesktopViewport() ? 'desktop' : 'mobile'), []);
    // The server/no-preference snapshot matches the client fallback exactly, so a
    // hydrated render never flips the drawer open.
    return useSyncExternalStore(subscribeViewport, getSnapshot, () => 'desktop');
}

/**
 * The seam the sidebar consumes. Also closes the mobile drawer on a crossing to
 * desktop: the drawer flag is a state cell, and a view may write a cell the way a
 * command does — the framework's SameValueZero change detection makes the write a
 * no-op when the flag is already false, so no extra guard or de-bounce is needed
 * and the effect can run on every viewport change.
 */
export function useViewport(): ViewportMode {
    const viewport = useViewportSnapshot();
    const instance = useWorkbench();

    useEffect(() => {
        if (viewport !== 'desktop') return;
        try {
            // Written by id, exactly as a command would: `chat.drawerOpen` belongs
            // to plugins/core.ts, and a dashboard disposed mid-effect (Fast Refresh,
            // a cancelled StrictMode teardown) throws 'disposed' on any cell access.
            // The drawer of a dead surface is nobody's business.
            instance.state<boolean>(CHAT_DRAWER_OPEN_STATE).set(false);
        } catch {
            // Ignored: the instance is gone.
        }
    }, [instance, viewport]);

    return viewport;
}
