// Copy: two overlapping rounded squares — the front square as a stroked
// rect, the rear one as an open stroke path (Feather copy geometry).
// Replaces the former U+29C9 TWO JOINED SQUARES text glyph on every
// copy action, the "clone" icon of the turn chrome.
import React from 'react';
import { IconBase, type IconProps } from './IconBase';

export const CopyIcon = (props: IconProps) => (
    <IconBase name="copy" {...props}>
        <rect x="9" y="9" width="13" height="13" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </IconBase>
);
