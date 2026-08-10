// Fork action icon for creating a new conversation from a persisted turn.
// The three nodes and branching paths use the same 24x24 stroke-only contract
// as the rest of src/icons, so the action remains legible beside copy/switch
// controls without depending on a platform font glyph.
import React from 'react';
import { IconBase, type IconProps } from './IconBase';

// The lower node is the source turn and the upper pair represents the original
// branch plus the newly created continuation. Circles make the fork direction
// recognizable even at the 14px control size used by message chrome.
export const ForkIcon = (props: IconProps) => (
    <IconBase name="fork" {...props}>
        <circle cx="6" cy="5" r="3" />
        <circle cx="18" cy="5" r="3" />
        <circle cx="18" cy="19" r="3" />
        <path d="M6 8v3a5 5 0 0 0 5 5h4" />
        <path d="M18 8v8" />
    </IconBase>
);
