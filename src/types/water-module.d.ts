// The engine's Water script ships without type declarations; its API is described by WaterApi.
declare module 'playcanvas/scripts/esm/water.mjs' {
    import type { Script } from 'playcanvas';
    export const Water: typeof Script;
}
