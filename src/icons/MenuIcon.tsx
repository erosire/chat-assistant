// Menu (hamburger): three strokes at y 6/12/18, x 3→21. Replaces the former
// U+2630 ☰ text glyph on the sidebar drawer toggle — the strokes keep their
// 2px weight at any size, which the text glyph could not do across fonts.
import React from 'react';
import { IconBase, type IconProps } from './IconBase';

export const MenuIcon = (props: IconProps) => (
    <IconBase name="menu" {...props}>
        <path d="M3 6h18M3 12h18M3 18h18" />
    </IconBase>
);
