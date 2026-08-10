// Right-pointing chevron: the send arrow. Replaces the former ">" ASCII
// text glyph inside the circular composer send button — the chevron keeps
// the authored ">" identity (a two-stroke arrow, not a paper plane) while
// matching the stroke weight of the rest of the icon family.
import React from 'react';
import { IconBase, type IconProps } from './IconBase';

export const ChevronRightIcon = (props: IconProps) => (
    <IconBase name="chevron-right" {...props}>
        <path d="M9 6l6 6-6 6" />
    </IconBase>
);
