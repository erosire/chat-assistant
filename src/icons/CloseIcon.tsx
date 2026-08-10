// Close/delete cross: two diagonal strokes forming an ×. Replaces the former
// U+00D7 MULTIPLICATION SIGN text glyph shared by the per-message delete
// button and the per-conversation sidebar delete button; both surfaces now
// draw the identical stroke cross instead of depending on a font's × design.
import React from 'react';
import { IconBase, type IconProps } from './IconBase';

export const CloseIcon = (props: IconProps) => (
    <IconBase name="close" {...props}>
        <path d="M6 6l12 12M18 6L6 18" />
    </IconBase>
);
