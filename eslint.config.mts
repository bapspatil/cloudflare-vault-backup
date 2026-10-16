import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'.claude',
		'graft',
		'dist',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'bun.lock',
		'tsconfig.json',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		files: ['src/core/**/*.ts'],
		rules: {
			'obsidianmd/prefer-window-timers': 'off',
			'no-restricted-imports': [
				'error',
				{ paths: [{ name: 'obsidian', message: 'src/core must stay free of the Obsidian API.' }] },
			],
		},
	},
	{
		files: ['test/**/*.ts'],
		rules: {
			'obsidianmd/hardcoded-config-path': 'off',
			'obsidianmd/no-nodejs-modules': 'off',
			'obsidianmd/prefer-window-timers': 'off',
			'no-restricted-globals': 'off',
		},
	},
);
