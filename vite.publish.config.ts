import { defineConfig } from 'vite';

import { thirdPartyLicenses } from './scripts/third-party-licenses.ts';

// Build for hosted pages: the PlayCanvas engine and its shipped scripts load from the jsDelivr CDN
// (pinned to the installed version) through an import map, so the published bundle contains only
// this project's code. The regular `npm run build` bundles everything for itch.io.
const PC = '2.24.2';
const CDN = process.env.PC_CDN || `https://cdn.jsdelivr.net/npm/playcanvas@${PC}`;
// Rapier (physics, Epic 2) the same way: pinned to the exact installed version
const RAPIER = '0.21.0';
const RAPIER_CDN =
    process.env.RAPIER_CDN || `https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@${RAPIER}/dist/rapier.mjs`;

export default defineConfig({
    worker: { format: 'es' },
    base: './',
    build: {
        outDir: 'dist-publish',
        rollupOptions: {
            external: ['playcanvas', /^playcanvas\/scripts\//, '@dimforge/rapier3d-compat'],
            output: {
                paths: (id: string) =>
                    id.startsWith('playcanvas/scripts/') ? `${CDN}/${id.slice('playcanvas/'.length)}` : id
            }
        }
    },
    plugins: [
        // the bundled packages' licence notices, next to the game (#104)
        thirdPartyLicenses(),
        {
            name: 'playcanvas-import-map',
            transformIndexHtml: () => [
                {
                    tag: 'script',
                    attrs: { type: 'importmap' },
                    children: JSON.stringify({
                        imports: { playcanvas: `${CDN}/build/playcanvas.mjs`, '@dimforge/rapier3d-compat': RAPIER_CDN }
                    }),
                    injectTo: 'head-prepend'
                }
            ]
        }
    ]
});
