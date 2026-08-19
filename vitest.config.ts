import { defineConfig } from 'vitest/config';

const buildTier = (process.env.BUILD_TIER || 'free').toLowerCase();

export default defineConfig({
	define: {
		__BUILD_TIER__: JSON.stringify(
			buildTier === 'premium' ? 'premium' : 'free',
		),
	},
	test: {
		globals: true,
		environment: 'happy-dom',
		// Serverless/Edge handlers are not browser code, and happy-dom's web
		// APIs are more permissive than the runtimes they actually ship to —
		// it accepts `new Response(body, { status: 204 })`, which Node and the
		// Edge runtime both reject. Running them under jsdom hid a real 204
		// bug in the Tempo relay. Test them where they run.
		environmentMatchGlobs: [
			['api/**', 'node'],
			['premium/api/**', 'node'],
		],
		setupFiles: ['./vitest.setup.ts'],
		include: ['**/*.test.{ts,tsx}', '**/__tests__/**/*.{ts,tsx}'],
		exclude: [
			'node_modules',
			'dist',
			'build',
			'.claude/**',
			'**/node_modules/**',
		],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'html', 'json', 'lcov'],
			include: ['frontend/**/*.{ts,tsx}', 'types/**/*.ts'],
			exclude: [
				'**/*.test.{ts,tsx}',
				'**/__tests__/**',
				'**/node_modules/**',
				'**/dist/**',
				'**/build/**',
				'**/*.config.{ts,js}',
				'**/*.d.ts',
				'**/types/**',
				'frontend/main.ts',
				'frontend/public/**',
			],
			// No thresholds set - just reporting for now
			all: true,
		},
	},
	resolve: {
		alias: {
			'@': '/frontend',
		},
	},
});
