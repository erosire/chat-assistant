// Bidirectional horizontal arrows identify the user/assistant role toggle.
// The icon uses the same 24x24 stroke geometry as every sibling in this folder
// so the role control remains visually consistent with copy and chevron actions.
import React from 'react';
import { IconBase, type IconProps } from './IconBase';

// Draw one right-pointing and one left-pointing arrow to make the reversible
// role conversion clear without relying on a font glyph such as "<->".
export const SwitchIcon = (props: IconProps) => (
    <IconBase name="switch" {...props}>
        <path d="M4 7h16l-3-3" />
        <path d="M20 17H4l3 3" />
    </IconBase>
);
