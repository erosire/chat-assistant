// Shared shell for every icon in src/icons.
//
// Design language: ALL icons draw on the same 24x24 grid with stroke-only
// geometry — no fills — strokeWidth 2, round caps and round joins. That is
// the Feather/Lucide visual system: any icon from this directory can sit
// next to any other in the same toolbar and read as one family. Color is
// NEVER baked in: `stroke="currentColor"` makes the icon inherit the text
// color of the button/panel around it (the chat assistant's TurnIconButton,
// SendButton, ScrollJumpButton, sidebar controls...), so one SVG serves
// every surface and every `greyed` opacity state for free.
//
// Accessibility contract: icons here are DECORATIVE — every control in this
// package carries its own aria-label, so the svg itself is aria-hidden and
// focusable=false (IE/Edge legacy guard). A consumer needing a MEANINGFUL
// icon should pass an aria-label/role through the spread props, which are
// applied AFTER the defaults and therefore win.
import React from 'react';

// Props accepted by every generated icon: `size` is the px edge of the
// square box (width + height stay locked together because icons are drawn
// on a square grid); everything else forwards onto the <svg> element
// (className for styledComponent composition, data hooks, overrides...).
export type IconProps = Omit<React.SVGProps<SVGSVGElement>, 'children'> & {
    size?: number;
};

// IconBase props add the machine name (exposed as data-icon — the stable
// test/integration hook, e.g. svg[data-icon="close"]) and the path children.
export type IconBaseProps = IconProps & {
    name: string;
    children: React.ReactNode;
};

export const IconBase = ({ name, size = 16, children, ...svgProps }: IconBaseProps) => (
    <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        data-icon={name}
        {...svgProps}
    >
        {children}
    </svg>
);
