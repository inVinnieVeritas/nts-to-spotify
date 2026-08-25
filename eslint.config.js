import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import ts from 'typescript-eslint';
import svelteConfig from './svelte.config.js';

const browserFiles = [
	'src/**/*.svelte',
	'src/**/*.svelte.ts',
	'src/**/*.svelte.js',
	'src/**/*.client.ts',
	'src/lib/actions/**/*.ts'
];

const nodeFiles = [
	'src/**/*.server.ts',
	'src/routes/**/+server.ts',
	'src/routes/**/+page.server.ts',
	'src/routes/**/+layout.server.ts',
	'src/**/*.test.ts',
	'*.{js,mjs,cjs,ts}'
];

export default defineConfig(
	globalIgnores(['.DS_Store', 'build/**', '.svelte-kit/**', 'package/**']),
	{
		...js.configs.recommended,
		files: ['**/*.{js,mjs,cjs,ts}']
	},
	...ts.configs.recommended.map((config) => ({
		...config,
		files: config.files ?? ['**/*.ts', '**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js']
	})),
	svelte.configs.base,
	{
		files: browserFiles,
		languageOptions: {
			globals: globals.browser
		}
	},
	{
		files: nodeFiles,
		languageOptions: {
			globals: globals.node
		}
	},
	{
		files: ['**/*.ts', '**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		rules: {
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
			]
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				parser: ts.parser,
				extraFileExtensions: ['.svelte'],
				svelteConfig
			}
		}
	},
	prettier,
	svelte.configs.prettier
);
