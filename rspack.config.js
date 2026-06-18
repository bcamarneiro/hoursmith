const path = require('node:path');
const {
	CopyRspackPlugin,
	DefinePlugin,
	ProvidePlugin,
} = require('@rspack/core');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const stdLibBrowser = require('node-stdlib-browser');
const {
	NodeProtocolUrlPlugin,
} = require('node-stdlib-browser/helpers/webpack/plugin');

const isOfflineMode =
	process.env.NODE_ENV === 'development' && process.env.OFFLINE_MODE === 'true';
const isDevelopment = process.env.NODE_ENV !== 'production';
const appBasePath = normalizeBasePath(process.env.APP_BASE_PATH || '/');
const buildTier = normalizeBuildTier(process.env.BUILD_TIER);
const usesRelativeAssetPaths =
	process.env.APP_ROUTER_MODE === 'hash' && appBasePath !== '/';

function normalizeBasePath(basePath) {
	const trimmed = basePath.trim();
	if (!trimmed || trimmed === '/') {
		return '/';
	}

	return `/${trimmed.replace(/^\/+|\/+$/g, '')}/`;
}

function normalizeBuildTier(tier) {
	const value = (tier || 'free').toLowerCase();
	if (value !== 'free' && value !== 'premium') {
		throw new Error(
			`Invalid BUILD_TIER "${tier}". Expected "free" or "premium".`,
		);
	}
	return value;
}

/** @type {import('@rspack/core').Configuration} */
module.exports = {
	entry: './frontend/main.tsx',
	output: {
		path: path.resolve(__dirname, 'dist'),
		filename: isDevelopment ? '[name].js' : '[name].[contenthash:8].js',
		chunkFilename: isDevelopment
			? '[name].chunk.js'
			: '[name].[contenthash:8].chunk.js',
		publicPath: usesRelativeAssetPaths ? '' : appBasePath,
	},
	experiments: {
		css: true,
	},
	watchOptions: {
		ignored: /node_modules/,
		poll: 1000,
	},
	// Prod uses 'hidden-source-map': maps are still emitted (for error-reporting
	// upload / debugging) but no `//# sourceMappingURL=` comment is added to the
	// chunks, so the full source isn't discoverable/fetchable by visitors.
	devtool: isDevelopment ? 'eval-cheap-module-source-map' : 'hidden-source-map',
	plugins: [
		new HtmlWebpackPlugin({
			template: './frontend/index.html',
		}),
		new CopyRspackPlugin({
			patterns: [
				{
					from: path.resolve(__dirname, 'frontend/public'),
					to: path.resolve(__dirname, 'dist'),
				},
			],
		}),
		new DefinePlugin({
			'process.env.NODE_ENV': JSON.stringify(
				process.env.NODE_ENV || 'development',
			),
			'process.env.OFFLINE_MODE': JSON.stringify(
				process.env.OFFLINE_MODE || 'false',
			),
			'process.env.APP_BASE_PATH': JSON.stringify(appBasePath),
			'process.env.APP_ROUTER_MODE': JSON.stringify(
				process.env.APP_ROUTER_MODE || 'browser',
			),
			// Supabase Auth client env (ADA-254 supplies real values).
			// Empty string fallbacks keep Free-tier builds compiling without leaking
			// secrets; the premium auth client throws at runtime if these are blank.
			'process.env.VITE_SUPABASE_URL': JSON.stringify(
				process.env.VITE_SUPABASE_URL || '',
			),
			'process.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(
				process.env.VITE_SUPABASE_ANON_KEY || '',
			),
			// PostHog product analytics (ADA-377). Publishable client key + host.
			// Empty fallbacks make analytics a no-op in free/self-host/CI builds.
			'process.env.VITE_POSTHOG_KEY': JSON.stringify(
				process.env.VITE_POSTHOG_KEY || '',
			),
			'process.env.VITE_POSTHOG_HOST': JSON.stringify(
				process.env.VITE_POSTHOG_HOST || 'https://eu.i.posthog.com',
			),
			__BUILD_TIER__: JSON.stringify(buildTier),
		}),
		new NodeProtocolUrlPlugin(),
		new ProvidePlugin({
			stream: stdLibBrowser.stream,
		}),
	],
	devServer: {
		host: '127.0.0.1',
		allowedHosts: 'all',
		static: [
			{
				directory: path.join(__dirname, 'dist'),
				watch: {
					poll: 1000,
				},
			},
			{
				directory: path.join(__dirname, 'frontend/public'),
				publicPath: '/',
				watch: {
					poll: 1000,
				},
			},
		],
		watchFiles: {
			paths: ['frontend/**/*', 'frontend/public/**/*', 'frontend/index.html'],
			options: {
				poll: 1000,
			},
		},
		port: Number(process.env.FRONTEND_PORT) || (isOfflineMode ? 5174 : 5173),
		historyApiFallback: true,
		hot: true,
		liveReload: true,
		client: {
			// Errors only. CSS Modules emit benign "Conflicting order" warnings
			// when the same stylesheet is imported into more than one chunk
			// (order is irrelevant for hashed/scoped class names). A warning
			// overlay renders an iframe that intercepts pointer events, which
			// silently breaks click-driven e2e smoke tests against the dev server.
			overlay: { errors: true, warnings: false, runtimeErrors: true },
			progress: true,
			reconnect: 5,
		},
		open: false,
	},
	module: {
		rules: [
			{
				test: /\.(ts|tsx)$/,
				use: [
					{
						loader: 'builtin:swc-loader',
						options: {
							jsc: {
								parser: {
									syntax: 'typescript',
									tsx: true,
								},
								target: 'es2020',
								transform: {
									react: {
										runtime: 'automatic',
										development: process.env.NODE_ENV !== 'production',
									},
								},
							},
						},
					},
				],
				exclude: /node_modules/,
			},
			{
				test: /\.module\.css$/,
				type: 'css/module',
				generator: {
					localIdentName: '[name]__[local]--[hash:base64:5]',
				},
			},
			{
				test: /\.css$/,
				exclude: /\.module\.css$/,
				type: 'css',
			},
			{
				test: /\.m?js$/,
				resolve: {
					fullySpecified: false,
				},
			},
		],
	},
	resolve: {
		extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs'],
		alias: {
			...stdLibBrowser,
		},
	},
	optimization: {
		splitChunks: {
			chunks: 'all',
		},
		runtimeChunk: 'single',
	},
};
