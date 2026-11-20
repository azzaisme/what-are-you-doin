import { defineConfig } from 'vite';

// Build for hosted pages: the PlayCanvas engine and its shipped scripts load from the jsDelivr CDN
// (pinned to the installed version) through an import map, so the published bundle contains only
// this project's code. The regular `npm run build` bundles everything for itch.io.
const PC = '2.24.2';
const CDN = process.env.PC_CDN || `https://cdn.jsdelivr.net/npm/playcanvas@${PC}`;

export default defineConfig({
    worker: { format: 'es' },
    base: './',
    build: {
        outDir: 'dist-publish',
        rollupOptions: {
            external: ['playcanvas', /^playcanvas\/scripts\//],
            output: {
                paths: (id: string) => (id.startsWith('playcanvas/scripts/') ? `${CDN}/${id.slice('playcanvas/'.length)}` : id)
            }
        }
    },
    plugins: [
        {
            name: 'playcanvas-import-map',
            transformIndexHtml: () => [
                {
                    tag: 'script',
                    attrs: { type: 'importmap' },
                    children: JSON.stringify({ imports: { playcanvas: `${CDN}/build/playcanvas.mjs` } }),
                    injectTo: 'head-prepend'
                }
            ]
        }
    ]
});
