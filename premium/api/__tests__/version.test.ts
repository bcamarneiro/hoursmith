/**
 * Version-drift guard (ADA-372).
 *
 * `premium/api/version.ts` keeps the running version as a hand-bumped `VERSION`
 * literal — reading `package.json` at runtime would force bundling gymnastics in
 * the Edge runtime, so the literal stays. The cost is that it can silently drift
 * from `package.json` `version` between releases.
 *
 * This test is the safety net: it parses the `VERSION` literal out of the source
 * file and asserts it matches `package.json`. CI goes red the moment a release
 * bumps `package.json` without bumping the literal (or vice versa). It does NOT
 * change the runtime — the literal remains the single source of truth at deploy.
 *
 * Paths are resolved from `process.cwd()` (the repo root that runs vitest), not
 * `import.meta.url`: vitest collects this file under both `premium/api/...` and a
 * phantom `api/...` root (the nested `premium/api/package.json` "type":"module"),
 * so a file-relative walk is not stable. The cwd is.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

function readVersionConst(): string {
	const src = readFileSync(resolve(repoRoot, 'premium/api/version.ts'), 'utf8');
	const match = src.match(/const\s+VERSION\s*=\s*['"]([^'"]+)['"]/);
	if (!match) {
		throw new Error(
			'Could not find a VERSION constant in premium/api/version.ts',
		);
	}
	return match[1];
}

function readPackageVersion(): string {
	const src = readFileSync(resolve(repoRoot, 'package.json'), 'utf8');
	return JSON.parse(src).version as string;
}

describe('GET /api/version — version literal', () => {
	it('matches package.json version (guards against drift)', () => {
		expect(readVersionConst()).toBe(readPackageVersion());
	});
});
