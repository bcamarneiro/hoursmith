#!/usr/bin/env node
/**
 * Generate the 1200x630 social-preview (og:image) asset for Hoursmith.
 *
 * Hand-authors a branded, deterministic SVG (Hoursmith wordmark + Billet H mark,
 * a one-line tagline, and the signature worklog-heatmap motif in the Forge ×
 * Ledger paper→ember ramp) and rasterizes it to PNG with rsvg-convert (librsvg),
 * falling back
 * to ImageMagick (magick / convert). The SVG is byte-stable across runs so the
 * committed PNG is fully reproducible. No npm rasterizer dependency is added.
 *
 * frontend/public/ is the static-asset source of truth; rspack CopyRspackPlugin
 * ships it to dist/ (site root), so output is served at https://hoursmith.io/<f>:
 *   frontend/public/og-image.svg  (source, committed)
 *   frontend/public/og-image.png  (1200x630; og:image / twitter:image target)
 *
 * Run: npm run gen:og   (or: node scripts/gen-og-image.cjs)
 */
const { writeFileSync, existsSync, statSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const FRONTEND_PUBLIC = path.join(ROOT, 'frontend', 'public');
const OUT_SVG = path.join(FRONTEND_PUBLIC, 'og-image.svg');
const OUT_PNG = path.join(FRONTEND_PUBLIC, 'og-image.png');

const W = 1200;
const H = 630;

// Forge × Ledger palette: ember brand (#c8431a) with a paper→ember heatmap ramp.
const BRAND = '#c8431a';
const SPARK = '#ee6b2d';
const PALETTE = ['#ece3d6', '#f0c8ad', '#e89e72', '#d4622f', '#c8431a'];
const INK = '#1c1714';
const PAPER = '#f4efe7';
const FONT =
	"'Hanken Grotesk', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const FONT_DISPLAY =
	"'Bricolage Grotesque', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// Deterministic GitHub-style contribution grid (byte-stable across runs).
function buildHeatmap(x0, y0, cols, rows, cell, gap) {
	let seed = 20260518;
	const rnd = () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
	const rects = [];
	for (let c = 0; c < cols; c++) {
		for (let r = 0; r < rows; r++) {
			const x = x0 + c * (cell + gap);
			const y = y0 + r * (cell + gap);
			const v = rnd();
			let level;
			if (v < 0.16) level = 0;
			else if (v < 0.36) level = 1;
			else if (v < 0.62) level = 2;
			else if (v < 0.85) level = 3;
			else level = 4;
			rects.push(
				`<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="5" fill="${PALETTE[level]}"/>`,
			);
		}
	}
	return rects.join('\n      ');
}

const heatmap = buildHeatmap(720, 196, 8, 7, 40, 11);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#faf6f0"/>
      <stop offset="1" stop-color="#efe6d9"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${BRAND}"/>
      <stop offset="1" stop-color="${SPARK}"/>
    </linearGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect x="0" y="0" width="${W}" height="10" fill="url(#accent)"/>

  <g transform="translate(80,80)">
    <!-- Billet H mark -->
    <rect width="76" height="76" rx="18" fill="${INK}"/>
    <rect x="19" y="14" width="11" height="48" rx="3" fill="${PAPER}"/>
    <rect x="46" y="14" width="11" height="48" rx="3" fill="${PAPER}"/>
    <rect x="19" y="32" width="38" height="12" rx="3" fill="${BRAND}"/>
    <circle cx="62" cy="29" r="2.4" fill="${SPARK}"/>
    <circle cx="66" cy="35" r="1.6" fill="${SPARK}"/>
  </g>
  <text x="176" y="134" font-family="${FONT_DISPLAY}"
    font-size="50" font-weight="800"><tspan fill="${INK}">Hour</tspan><tspan fill="${BRAND}">smith</tspan></text>

  <text x="80" y="290" font-family="${FONT_DISPLAY}"
    font-size="48" font-weight="800" fill="${INK}">Chase missing Jira</text>
  <text x="80" y="346" font-family="${FONT_DISPLAY}"
    font-size="48" font-weight="800" fill="url(#accent)">worklogs before</text>
  <text x="80" y="402" font-family="${FONT_DISPLAY}"
    font-size="48" font-weight="800" fill="url(#accent)">invoice day.</text>

  <text x="82" y="456" font-family="${FONT}"
    font-size="26" font-weight="500" fill="#574d43">A team-lead&#39;s dashboard.</text>
  <text x="82" y="492" font-family="${FONT}"
    font-size="26" font-weight="500" fill="#574d43">Browser-only &#8212; your data never leaves.</text>

  <g transform="translate(80,512)">
    <rect width="232" height="54" rx="27" fill="${INK}"/>
    <text x="116" y="36" text-anchor="middle" font-family="${FONT}"
      font-size="25" font-weight="600" fill="${PAPER}">hoursmith.io</text>
  </g>

  <g>
    <text x="720" y="176" font-family="${FONT}"
      font-size="22" font-weight="600" fill="#938778">Logged hours, at a glance</text>
    ${heatmap}
  </g>

  <g transform="translate(720,572)">
    <text x="0" y="15" font-family="${FONT}" font-size="18" font-weight="500" fill="#938778">Less</text>
    <rect x="52" y="2" width="18" height="18" rx="4" fill="${PALETTE[0]}"/>
    <rect x="76" y="2" width="18" height="18" rx="4" fill="${PALETTE[1]}"/>
    <rect x="100" y="2" width="18" height="18" rx="4" fill="${PALETTE[2]}"/>
    <rect x="124" y="2" width="18" height="18" rx="4" fill="${PALETTE[3]}"/>
    <rect x="148" y="2" width="18" height="18" rx="4" fill="${PALETTE[4]}"/>
    <text x="176" y="15" font-family="${FONT}" font-size="18" font-weight="500" fill="#938778">More</text>
  </g>
</svg>
`;

writeFileSync(OUT_SVG, svg);
console.log(`Wrote ${OUT_SVG}`);

function viaCli(cmd, args) {
	const res = spawnSync(cmd, args, { stdio: ['ignore', 'ignore', 'ignore'] });
	return res.status === 0 && !res.error;
}

let ok = viaCli('rsvg-convert', [
	'-w',
	String(W),
	'-h',
	String(H),
	'-o',
	OUT_PNG,
	OUT_SVG,
]);
if (!ok) {
	for (const m of ['magick', 'convert']) {
		if (
			viaCli(m, [
				'-background',
				'none',
				'-density',
				'144',
				OUT_SVG,
				'-resize',
				`${W}x${H}`,
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
	console.log(`Wrote ${OUT_PNG} (${W}x${H}, ${kb}KB)`);
} else {
	console.error(
		[
			'\nNo SVG rasterizer found (no rsvg-convert or ImageMagick on PATH).',
			`The SVG source was written to ${OUT_SVG}. Install a rasterizer`,
			'(e.g. `brew install librsvg`) and re-run, or rasterize the SVG to',
			`${OUT_PNG} at ${W}x${H} with any tool.`,
		].join('\n'),
	);
	process.exit(1);
}
