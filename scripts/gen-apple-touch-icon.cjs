#!/usr/bin/env node
/**
 * Generate the 180x180 apple-touch-icon PNG for Hoursmith.
 *
 * iOS ignores SVG favicons/manifest icons, so it needs a dedicated raster
 * apple-touch-icon. We rasterize the committed `frontend/public/pwa-icon.svg`
 * (the opaque Billet H mark) to a 180x180 PNG with rsvg-convert (librsvg),
 * falling back to ImageMagick (magick / convert) — the same rasterizer chain
 * as gen-og-image.cjs, so no npm rasterizer dependency is added.
 *
 * frontend/public/ is the static-asset source of truth; rspack CopyRspackPlugin
 * ships it to dist/ (site root), so the output is served at
 *   https://hoursmith.io/apple-touch-icon.png
 *
 * Run: npm run gen:apple-touch-icon   (or: node scripts/gen-apple-touch-icon.cjs)
 */
const { existsSync, statSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const FRONTEND_PUBLIC = path.join(ROOT, 'frontend', 'public');
const SRC_SVG = path.join(FRONTEND_PUBLIC, 'pwa-icon.svg');
const OUT_PNG = path.join(FRONTEND_PUBLIC, 'apple-touch-icon.png');

const SIZE = 180;

function viaCli(cmd, args) {
	const res = spawnSync(cmd, args, { stdio: ['ignore', 'ignore', 'ignore'] });
	return res.status === 0 && !res.error;
}

let ok = viaCli('rsvg-convert', [
	'-w',
	String(SIZE),
	'-h',
	String(SIZE),
	'-o',
	OUT_PNG,
	SRC_SVG,
]);
if (!ok) {
	for (const m of ['magick', 'convert']) {
		if (
			viaCli(m, [
				'-background',
				'#1c1714',
				'-density',
				'144',
				SRC_SVG,
				'-resize',
				`${SIZE}x${SIZE}`,
				OUT_PNG,
			])
		) {
			ok = true;
			break;
		}
	}
}

if (ok && existsSync(OUT_PNG)) {
	const kb = (statSync(OUT_PNG).size / 1024).toFixed(1);
	console.log(`Wrote ${OUT_PNG} (${SIZE}x${SIZE}, ${kb}KB)`);
} else {
	console.error(
		[
			'\nNo SVG rasterizer found (no rsvg-convert or ImageMagick on PATH).',
			'Install a rasterizer (e.g. `brew install librsvg`) and re-run, or',
			`rasterize ${SRC_SVG} to ${OUT_PNG} at ${SIZE}x${SIZE} with any tool.`,
		].join('\n'),
	);
	process.exit(1);
}
