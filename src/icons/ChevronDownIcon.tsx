// Down-pointing chevron: the "V" state of the message list's edge-jump
// control (jump to bottom). Replaces the former U+2304 DOWN ARROWHEAD text
// glyph — the two-stroke chevron reads correctly at 16px in every font
// environment, which the arrowhead glyph did not.
import React from 'react';
import { IconBase, type IconProps } from './IconBase';

export const ChevronDownIcon = (props: IconProps) => (
    <IconBase name="chevron-down" {...props}>
        <path d="M6 9l6 6 6-6" />
    </IconBase>
);
