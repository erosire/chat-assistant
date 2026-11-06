// React seam between the headless core and this distribution's views.
//
// The core has no React dependency at all; this context is how a rendered tree
// gets hold of the composed `Dashboard` instance (to read state, fetch services,
// execute commands and consume slots). It is host-local on purpose — a different
// styling target would provide its own context/shell and reuse the same plugins.
//
// Ported from packages/underload/dashboard/example/src/app/workbench.tsx.
import { createContext, useContext, type ReactNode } from 'react';
import type { Dashboard } from '@underload/dashboard';

const WorkbenchContext = createContext<Dashboard | null>(null);

export function WorkbenchProvider({
    instance,
    children
}: {
    instance: Dashboard;
    children: ReactNode;
}) {
    return <WorkbenchContext.Provider value={instance}>{children}</WorkbenchContext.Provider>;
}

/**
 * The composed dashboard. Throws rather than returning `null`: every consumer is
 * rendered under <WorkbenchProvider>, so a missing instance is a composition bug
 * and an explicit message beats a confusing "cannot read state of null".
 */
export function useWorkbench(): Dashboard {
    const instance = useContext(WorkbenchContext);
    if (instance === null) {
        throw new Error('useWorkbench() needs a <WorkbenchProvider> with a dashboard() instance');
    }
    return instance;
}
