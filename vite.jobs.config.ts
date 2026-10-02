import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
	ssr: { noExternal: ['@sveltejs/kit', 'esm-env'] },
	resolve: {
		alias: {
			'$env/dynamic/private': fileURLToPath(new URL('./scripts/job-env.ts', import.meta.url)),
			$lib: fileURLToPath(new URL('./src/lib', import.meta.url))
		}
	},
	build: {
		ssr: 'src/jobs/catalog-schedules.ts',
		outDir: 'build-jobs',
		rolldownOptions: { output: { entryFileNames: 'catalog-schedules.mjs' } }
	}
});
