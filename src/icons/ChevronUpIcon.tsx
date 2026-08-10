// Up-pointing chevron: the "^" state of the message list's edge-jump
// control (jump to top). Replaces the former U+2303 UP ARROWHEAD text
// glyph; geometrically the vertical mirror of ChevronDownIcon so the two
// flip states of the jump button are pixel-consistent.
import React from 'react';
import { IconBase, type IconProps } from './IconBase';

export const ChevronUpIcon = (props: IconProps) => (
    <IconBase name="chevron-up" {...props}>
        <path d="M6 15l6-6 6 6" />
    </IconBase>
);
