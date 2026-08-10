// Deterministic tests for the shared SVG icon family: every icon must share
// the one stroke-system contract (24x24 grid, currentColor stroke, width 2,
// round caps/joins, decorative-only a11y) so icons can sit side by side as
// one visual family, and each icon locks its exact path geometry so an
// accidental redraw is a test failure, not a silent UI change.
import { render, screen } from '@testing-library/react';
import type { ComponentType } from 'react';
import { describe, expect, it } from 'vitest';
import {
    ChevronDownIcon,
    ChevronRightIcon,
    ChevronUpIcon,
    CloseIcon,
    CopyIcon,
    EditIcon,
    MenuIcon
} from '.';

// The full family as [name, Component, exact inner SVG markup] rows so the
// shared contract runs against ALL icons and the geometry pin of each icon
// lives in exactly one place.
const family: ReadonlyArray<readonly [string, ComponentType<{ size?: number }>, string]> = [
    ['menu', MenuIcon, '<path d="M3 6h18M3 12h18M3 18h18"></path>'],
    ['close', CloseIcon, '<path d="M6 6l12 12M18 6L6 18"></path>'],
    ['edit', EditIcon, '<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>'],
    [
        'copy',
        CopyIcon,
        '<rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>'
    ],
    ['chevron-right', ChevronRightIcon, '<path d="M9 6l6 6-6 6"></path>'],
    ['chevron-down', ChevronDownIcon, '<path d="M6 9l6 6 6-6"></path>'],
    ['chevron-up', ChevronUpIcon, '<path d="M6 15l6-6 6 6"></path>']
];

describe('icons', () => {
    it('draws every icon on the shared 24x24 stroke system with the decorative-a11y contract', () => {
        for (const [name, Icon] of family) {
            const { container, unmount } = render(<Icon />);
            const svg = container.querySelector(`svg[data-icon="${name}"]`) as SVGSVGElement;
            expect(svg).not.toBeNull();
            // Default box: 16px square...
            expect(svg.getAttribute('width')).toBe('16');
            expect(svg.getAttribute('height')).toBe('16');
            // ...on the shared 24x24 drawing grid...
            expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
            // ...stroke-only geometry inherited from the surrounding text color...
            expect(svg.getAttribute('fill')).toBe('none');
            expect(svg.getAttribute('stroke')).toBe('currentColor');
            expect(svg.getAttribute('stroke-width')).toBe('2');
            expect(svg.getAttribute('stroke-linecap')).toBe('round');
            expect(svg.getAttribute('stroke-linejoin')).toBe('round');
            // ...and decorative-only accessibility (controls own the names).
            expect(svg.getAttribute('aria-hidden')).toBe('true');
            expect(svg.getAttribute('focusable')).toBe('false');
            unmount();
        }
    });

    it('locks every icon to its exact path geometry', () => {
        for (const [name, Icon, markup] of family) {
            const { container, unmount } = render(<Icon />);
            const svg = container.querySelector(`svg[data-icon="${name}"]`) as SVGSVGElement;
            expect(svg.innerHTML).toBe(markup);
            unmount();
        }
    });

    it('keeps the box square when a size is passed and lets spread props override the defaults', () => {
        render(<MenuIcon size={20} data-testid="menu" aria-label="Menu" aria-hidden={false} />);
        const svg = screen.getByTestId('menu');
        expect(svg.getAttribute('width')).toBe('20');
        expect(svg.getAttribute('height')).toBe('20');
        // Spread props land AFTER the defaults: a consumer promoting the icon
        // to meaningful content can override the decorative a11y defaults.
        expect(svg.getAttribute('aria-label')).toBe('Menu');
        expect(svg.getAttribute('aria-hidden')).toBe('false');
    });
});
