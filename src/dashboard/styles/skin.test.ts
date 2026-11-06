// The vendored skin's breakpoints, pinned against the JS viewport seam.
//
// WHY A TEST READS CSS AT ALL: the stylesheet is otherwise invisible to this suite
// (no test renders the skin), so the one thing that CAN be checked mechanically is
// the number. N3 is exactly a number drifting: three inner `@media` blocks still
// flipped at `max-width: 820px` while the station grid itself flips at 899
// (base.css:397), which left the 820-899 band with an element reflowed for a phone
// inside a region the layout still treated as a wide column. `viewport.ts` publishes
// THE threshold as `DESKTOP_QUERY` ('(min-width: 900px)'), and its comment used to
// claim the CSS disagreed with it; both directions are pinned here so the
// disagreement cannot come back silently.
//
// WHY `node:fs` AND NOT `./x.css?raw`: Vitest stubs every CSS request (the default
// `test.css: false`), so a `?raw` import of a stylesheet yields an empty string here
// even though Vite's build serves the real text. The filesystem is the one source
// that cannot be stubbed, and `__dirname` is this file's own directory, so the test
// reads the very files the bundle compiles regardless of the runner's cwd.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESKTOP_QUERY } from '../viewport';

/** The stylesheet directory (this file lives in it). */
const SKIN_DIR = __dirname;

/** Every `*.css` file the skin ships, sorted so a failure names a stable order. */
const skinFiles = (): string[] =>
    readdirSync(SKIN_DIR)
        .filter((name) => name.endsWith('.css'))
        .sort();

const readSkin = (name: string): string => readFileSync(join(SKIN_DIR, name), 'utf-8');

/**
 * Every NARROW-layout flip one stylesheet declares, i.e. the px values inside a
 * `@media (max-width: ...)`. Deliberately not a bare `max-width:` scan: a measure
 * cap (settings.css `.settings { max-width: 520px }`) or a text ellipsis bound
 * (composer.css `max-width: 26ch`) is not a breakpoint and must not be swept into
 * this assertion.
 */
const narrowFlipsIn = (source: string): number[] =>
    [...source.matchAll(/@media\s*\(\s*max-width:\s*(\d+)px/g)].map((match) => Number(match[1]));

/** The desktop threshold as a number, derived from the seam's own constant. */
const desktopFrom = (query: string): number => {
    const match = /\(min-width:\s*(\d+)px\)/.exec(query);
    if (match === null) throw new Error(`Unexpected DESKTOP_QUERY: ${query}`);
    return Number(match[1]);
};

/** The widest stage layout still gets before the middle column is squeezed. */
const WIDE_SQUEEZE = 1120;

describe('the skin agrees with the viewport seam', () => {
    it('flips every region and every element at the same crossing (899)', () => {
        // The directory listing is part of the assertion: a NEW stylesheet has to be
        // given an expectation here, which is what keeps a fourth column of rules from
        // inventing its own breakpoint.
        expect(skinFiles()).toEqual([
            'agents.css',
            'base.css',
            'composer.css',
            'index.css',
            'notices.css',
            'sessions.css',
            'settings.css',
            'tokens.css',
            'tools.css',
            'transcript.css'
        ]);

        const narrow = desktopFrom(DESKTOP_QUERY) - 1;
        expect(narrow).toBe(899);
        const flips = skinFiles().reduce<Record<string, number[]>>((accumulated, name) => {
            accumulated[name] = narrowFlipsIn(readSkin(name));
            return accumulated;
        }, {});

        // Exact per-file lists: a NEW inner media query at a different width — or one
        // of the four 899 blocks moving again — fails here with the file named.
        expect(flips).toEqual({
            'agents.css': [],
            'base.css': [WIDE_SQUEEZE, narrow],
            'composer.css': [narrow],
            'index.css': [],
            'notices.css': [narrow],
            'sessions.css': [narrow],
            'settings.css': [narrow],
            'tokens.css': [],
            'tools.css': [],
            'transcript.css': []
        });
    });

    it('leaves no 820px rule anywhere in the skin', () => {
        // The number the drift was made of: nothing in the stylesheet may still claim
        // a narrow layout starts at 820.
        const offenders = skinFiles().filter((name) => narrowFlipsIn(readSkin(name)).includes(820));
        expect(offenders).toEqual([]);
    });

    it('documents the breakpoint the seam actually ships', () => {
        // N3 also corrected the comment in the seam itself: it described base.css as
        // flipping at 820, which was true of an earlier revision of the skin only.
        const seam = readFileSync(join(SKIN_DIR, '..', 'viewport.ts'), 'utf-8');
        expect(seam).toContain('max-width: 899px');
        expect(seam).not.toContain('820');
    });
});
