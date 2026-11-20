/**
 * Per-material shader chunk overrides for the voxel materials (GLSL; the device is pinned to
 * WebGL2, see ADR 0003).
 *
 * - WATER_CAUSTICS: the engine Water script's underwater caustics, reproduced here because these
 *   per-material chunks replace its global litUserMainEndPS for voxel materials.
 * - VOXEL_GRID: optional debug overlay drawing the global voxel lattice on every voxel face. It is
 *   computed from world position, so it proves that moving faces lie on the same grid.
 */

export const VOXEL_LIT_DECLARATIONS_GLSL = /* glsl */ `
    uniform float uVoxelGridLines;
    #if defined(WATER_CAUSTICS) && !defined(SHADOW_PASS) && !defined(PICK_PASS) && !defined(PREPASS_PASS)
        uniform float waterLevel;
        uniform sampler2D waterCausticsMap;
        uniform vec4 waterCausticsParams;
        uniform vec3 waterCausticsColor;
        uniform float waterTime;
    #endif
`;

import { INV_GRID_SIZE } from '../voxels/grid.ts';

export const VOXEL_LIT_MAIN_END_GLSL = /* glsl */ `
    #if defined(WATER_CAUSTICS) && !defined(SHADOW_PASS) && !defined(PICK_PASS) && !defined(PREPASS_PASS)
    {
        float depthBelow = waterLevel - vPositionW.y;
        if (depthBelow > 0.0) {
            vec2 cuv = vPositionW.xz * waterCausticsParams.x;
            float ct = waterTime * waterCausticsParams.y;
            float ca = texture2D(waterCausticsMap, cuv + vec2(ct, ct * 0.8)).x;
            float cb = texture2D(waterCausticsMap, cuv * 1.37 + vec2(-ct * 1.1, ct * 0.9)).y;
            float caustic = pow(clamp((ca + cb) * 0.5 * 2.2 - 0.9, 0.0, 1.0), 2.0);
            float gate = exp(-depthBelow / waterCausticsParams.w) * min(depthBelow * 4.0, 1.0);
            gate *= clamp(litArgs_worldNormal.y, 0.0, 1.0);
            gl_FragColor.rgb *= vec3(1.0) + waterCausticsColor * (caustic * waterCausticsParams.z * gate);
        }
    }
    #endif
    #if defined(VOXEL_GRID) && !defined(SHADOW_PASS) && !defined(PICK_PASS) && !defined(PREPASS_PASS)
    if (uVoxelGridLines > 0.0) {
        vec3 g = vPositionW * ${INV_GRID_SIZE.toFixed(4)};
        vec3 d = 0.5 - abs(fract(g) - 0.5);
        vec3 w = max(fwidth(g), vec3(1e-4));
        vec3 l = 1.0 - smoothstep(vec3(0.0), w * 1.25, d);
        vec3 n = abs(litArgs_worldNormal);
        float line = max(l.x * (1.0 - n.x), max(l.y * (1.0 - n.y), l.z * (1.0 - n.z)));
        gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.015, 0.02, 0.03), line * 0.75 * uVoxelGridLines);
    }
    #endif
`;
