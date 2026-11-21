/// <reference types="vite/client" />

interface ImportMetaEnv {
    /** TURN relay for online play outside claude.ai: comma-separated turn:/turns: URLs (build time). */
    readonly VITE_TURN_URLS?: string;
    readonly VITE_TURN_USERNAME?: string;
    readonly VITE_TURN_CREDENTIAL?: string;
}

declare module 'playcanvas/scripts/esm/camera-controls.mjs' {
    import type { Script } from 'playcanvas';

    export const CameraControls: typeof Script & (new () => Script);
}

declare module 'playcanvas/scripts/esm/grid.mjs' {
    import type { Script } from 'playcanvas';

    export const Grid: typeof Script & (new () => Script);
}

declare module 'playcanvas/scripts/esm/sky/procedural-sky.mjs' {
    import type { Script } from 'playcanvas';

    export const ProceduralSky: typeof Script & (new () => Script);
}
