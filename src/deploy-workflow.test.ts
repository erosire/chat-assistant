/**
 * The GitHub Pages deploy contract (B1), pinned as a test.
 *
 * WHY THIS EXISTS: `@underload/dashboard` is a monorepo WORKSPACE package that has
 * never been published to npm — the registry answers 404 for `@underload/dashboard@*`
 * (verified: `npm view @underload/dashboard version` -> E404). Its "*" specifier has
 * to STAY "*" in package.json, because a `file:` specifier would stop the monorepo
 * workspace from resolving the package to its SOURCE, which is what dev, the test
 * suite and `tsc` all depend on. The Pages workflow therefore rewrites the specifier
 * at CI time to the committed tarball under `vendor/`.
 *
 * Nothing in the runtime test suite can observe that pipeline — the app resolves the
 * workspace copy either way — so the assertions here are about the ARTIFACT and the
 * WORKFLOW: the vendored tarball exists (one, and only one), and the workflow points
 * the dependency at it BEFORE `npm install` runs, next to the existing
 * `@underload/service` strip. Delete the tarball or the step and this test fails
 * instead of a production deploy failing on a 404.
 *
 * The end-to-end proof (install from the tarball + `vite build`) was run as a
 * simulation of the exact workflow steps; see the task report.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The distribution repository root (this file lives in `src/`). */
const ROOT = join(__dirname, '..');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'deploy.yml');
const VENDOR = join(ROOT, 'vendor');

/** Every vendored dashboard artifact, by file name. */
const vendoredTarballs = (): string[] => {
    if (!existsSync(VENDOR)) return [];
    return readdirSync(VENDOR)
        .filter((name) => name.startsWith('underload-dashboard-') && name.endsWith('.tgz'))
        .sort();
};

describe('the Pages deploy resolves the unpublished workspace package', () => {
    it('ships exactly one vendored @underload/dashboard tarball', () => {
        // The workflow step refuses to guess when this is not true, so the same rule
        // is asserted here: `underload-dashboard-<version>.tgz`, once.
        const tarballs = vendoredTarballs();
        expect(tarballs).toHaveLength(1);
        expect(tarballs[0]).toMatch(/^underload-dashboard-\d+\.\d+\.\d+\.tgz$/);
    });

    it('rewrites the dependency to the tarball before installing, beside the service strip', () => {
        const workflow = readFileSync(WORKFLOW, 'utf-8');
        // Anchored on the STEP HEADERS, not on loose words: "npm install" also appears
        // in the file's explanatory comment, and an index into prose proves nothing
        // about the order the runner executes.
        const installStep = workflow.indexOf('- name: Install dependencies');
        const vendorStep = workflow.indexOf('- name: Point the unpublished workspace package');
        const stripStep = workflow.indexOf('- name: Strip server-only dependency');

        // All three exist, and both manifest edits happen BEFORE the install — after
        // it, the 404 has already failed the build.
        expect(installStep).toBeGreaterThan(-1);
        expect(vendorStep).toBeGreaterThan(-1);
        expect(stripStep).toBeGreaterThan(-1);
        expect(vendorStep).toBeLessThan(installStep);
        expect(stripStep).toBeLessThan(installStep);

        // The step rewrites the specifier to the vendored file, and the artifact it
        // reads is the one committed above.
        const vendorScript = workflow.slice(vendorStep, installStep);
        expect(vendorScript).toContain("const VENDORED = 'vendor';");
        expect(vendorScript).toContain("const PACK_PREFIX = 'underload-dashboard-';");
        expect(vendorScript).toContain('file:${VENDORED}/${tarballs[0]}');
        expect(vendoredTarballs()).toHaveLength(1);

        // `@underload/dashboard` is NOT stripped (the browser build imports it) and the
        // manifest keeps its workspace-resolvable specifier for the monorepo.
        expect(workflow).not.toContain("delete manifest.dependencies['@underload/dashboard']");
        const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as {
            dependencies: Record<string, string>;
        };
        expect(manifest.dependencies['@underload/dashboard']).toBe('*');
    });
});
