// Edit pencil: single continuous stroke drawing the pencil body + tip +
// highlight arc (Feather edit-2 geometry). Replaces the former U+270E LOWER
// RIGHT PENCIL text glyph on the per-message and system-prompt edit pens.
import React from 'react';
import { IconBase, type IconProps } from './IconBase';

export const EditIcon = (props: IconProps) => (
    <IconBase name="edit" {...props}>
        <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </IconBase>
);
