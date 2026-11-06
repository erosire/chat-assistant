// Layout plugin: declares the workstation shape and contributes the T1
// placeholders. Vendored and adapted from
// packages/underload/dashboard/example/src/plugins/layout.ts.
//
// It owns no state — layout is configuration, not something the operator mutates
// at runtime — and publishes it as two services (`layout.brand`, `layout.regions`)
// plus one placeholder contribution per region slot. The shell reads the services
// and renders whatever is in the channels; that is the whole reason the shell has
// no feature list.
//
// No JSX in this file (it is a .ts on purpose: the plugin layer stays a plain
// data module), so every placeholder is a `{ title, hint, body }` descriptor and
// the shell renders the chrome + the string body.
import type { DashboardPlugin } from '@underload/dashboard';
import {
    ASIDE_SLOT,
    LAYOUT_ASIDE_PLACEHOLDER,
    LAYOUT_BRAND_SERVICE,
    LAYOUT_REGIONS_SERVICE,
    LAYOUT_SIDEBAR_PLACEHOLDER,
    LAYOUT_STAGE_PLACEHOLDER,
    PLUGIN_IDS,
    SIDEBAR_SLOT,
    STAGE_SLOT,
    type BrandSpec,
    type PanelValue,
    type RegionSpec
} from '../contract';
import { APP_VERSION } from '../../version';

// Rail, stage, aside — the three-column chat workstation. `order` is the visual
// order on wide viewports; styles/base.css re-orders them on narrow ones, so the
// declaration stays about meaning, not pixels. `slot` is the channel the shell
// reads for that column.
const REGIONS: readonly RegionSpec[] = [
    { id: 'sidebar', label: 'Session rail', order: 10, slot: SIDEBAR_SLOT },
    { id: 'stage', label: 'Work stage', order: 20, slot: STAGE_SLOT },
    { id: 'aside', label: 'Inspector aside', order: 30, slot: ASIDE_SLOT }
];

// Static brand metadata for the station bar. The version comes from
// src/version.ts (the package.json `version` injected as __APP_VERSION__), so the
// skin never carries a hardcoded duplicate of it.
const BRAND: BrandSpec = {
    name: 'Chat Assistant',
    tagline: 'Plugin-composed workstation — every surface below registers itself',
    chip: `v${APP_VERSION}`,
    notice: 'Rail, stage and inspector are slot contributions — registering a plugin adds a surface.'
};

// Placeholder contributions sit at order 0, which is the LOWEST band, so the
// first real contribution to a region replaces them under the shell's
// winner-takes-region rule (highest `order` per region wins — see
// WorkstationShell.tsx:62-81). FINAL BANDS: the three real surfaces claim
// 40 (rail) / 50 (stage) / 60 (inspector) in plugins/surfaces.ts, so these
// descriptors are what a channel renders only when its owner is absent (a headless
// variant build). A contributor that wants to REPLACE a column takes that column's
// band + 10; one that wants to sit BELOW it takes a lower number.
const PLACEHOLDER_SIDEBAR: PanelValue = {
    title: 'Rail',
    hint: 'placeholder',
    body: 'Sessions, agents, tools and settings will render in this column.'
};

const PLACEHOLDER_STAGE: PanelValue = {
    title: 'Stage',
    hint: 'placeholder',
    body: 'The transcript and composer will render in this column.'
};

const PLACEHOLDER_ASIDE: PanelValue = {
    title: 'Inspector',
    hint: 'placeholder',
    body: 'Turn details, usage and skin settings will render in this column.'
};

export function createLayoutPlugin(): DashboardPlugin {
    return {
        id: PLUGIN_IDS.layout,
        setup(api) {
            api.service<BrandSpec>(LAYOUT_BRAND_SERVICE, BRAND);
            api.service<readonly RegionSpec[]>(LAYOUT_REGIONS_SERVICE, REGIONS);

            // Order 0 on every channel: replaceable by any real contribution.
            api.slot<PanelValue>(SIDEBAR_SLOT, {
                id: LAYOUT_SIDEBAR_PLACEHOLDER,
                order: 0,
                value: PLACEHOLDER_SIDEBAR
            });
            api.slot<PanelValue>(STAGE_SLOT, {
                id: LAYOUT_STAGE_PLACEHOLDER,
                order: 0,
                value: PLACEHOLDER_STAGE
            });
            api.slot<PanelValue>(ASIDE_SLOT, {
                id: LAYOUT_ASIDE_PLACEHOLDER,
                order: 0,
                value: PLACEHOLDER_ASIDE
            });
        }
    };
}
