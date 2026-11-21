/**
 * Prototype "pixel game" look (`?look=pixel`, or Lighting → Look in the debug panel, or the L key).
 *
 * - The scene renders at a fraction of the screen resolution (`rendering.renderTargetScale`), and
 *   the composition samples it at texel centres, so the upscale is nearest neighbour: hard square
 *   pixels.
 * - Outlines only where the depth jumps (an object's silhouette against what is behind it), found
 *   with a second difference of the linear depth across one low-res texel, so flat ground and
 *   slopes stay clean. They darken the object's own colour rather than paint black, and fade out
 *   with distance so the background does not turn into noise.
 * - Hairline cracks between voxel faces, which the nearest upscale would blow up into big bright
 *   pixels, are filled from their neighbours.
 * - Lone sparkles (sub-pixel specular glints) are replaced by their neighbours, for the same reason.
 * - Flatter colour: posterized to a few levels per channel after gamma.
 *
 * Bloom, vignette and MSAA are switched off while it is on (they blur the pixel edges).
 */

import { COMPOSESLOT_OUTPUT, COMPOSESLOT_SCENE, CameraFrameEffect, FRAMERESOURCE_DEPTH } from 'playcanvas';
import type { CameraFrame, GraphicsDevice } from 'playcanvas';

const outlineGLSL = /* glsl */ `
    uniform vec4 pixelOutline; // x: strength, y: relative threshold, z: fade start (m), w: fade end (m)
    vec4 applyPixelOutline(vec4 scene, vec2 uv) {
        vec2 size = sceneTextureSize.xy;
        vec2 texel = sceneTextureSize.zw;
        vec2 c = (floor(uv * size) + 0.5) * texel;
        vec4 col = texture2DLod(sceneTexture, c, 0.0);
        float d = getLinearScreenDepth(c);
        float l = getLinearScreenDepth(c - vec2(texel.x, 0.0));
        float r = getLinearScreenDepth(c + vec2(texel.x, 0.0));
        float b = getLinearScreenDepth(c - vec2(0.0, texel.y));
        float t = getLinearScreenDepth(c + vec2(0.0, texel.y));
        // a hairline crack between voxel faces (sky or far ground seen through it) is one texel
        // farther than both neighbours on an axis: take their colour and depth instead
        float gap = 0.1 * d + 0.1;
        if (l < d - gap && r < d - gap) {
            col = texture2DLod(sceneTexture, c - vec2(texel.x, 0.0), 0.0);
            d = min(l, r);
        } else if (b < d - gap && t < d - gap) {
            col = texture2DLod(sceneTexture, c - vec2(0.0, texel.y), 0.0);
            d = min(b, t);
        }
        // this texel is nearer than the line through its neighbours: it sits on a silhouette. The
        // surface behind must be at least two texels deep, so one-texel holes get no outline ring
        float l2 = min(l, getLinearScreenDepth(c - vec2(2.0 * texel.x, 0.0)));
        float r2 = min(r, getLinearScreenDepth(c + vec2(2.0 * texel.x, 0.0)));
        float b2 = min(b, getLinearScreenDepth(c - vec2(0.0, 2.0 * texel.y)));
        float t2 = min(t, getLinearScreenDepth(c + vec2(0.0, 2.0 * texel.y)));
        float thr = pixelOutline.y * d + 0.04;
        float edge = max(
            step(thr, max(l2, r2) - d) * step(thr * 0.5, (l2 + r2) * 0.5 - d),
            step(thr, max(b2, t2) - d) * step(thr * 0.5, (b2 + t2) * 0.5 - d)
        );
        // a lone texel much brighter than all four neighbours is a sparkle (a sub-pixel specular
        // glint the full-size image hides): the nearest upscale would make it a big bright pixel
        vec3 n0 = texture2DLod(sceneTexture, c - vec2(texel.x, 0.0), 0.0).rgb;
        vec3 n1 = texture2DLod(sceneTexture, c + vec2(texel.x, 0.0), 0.0).rgb;
        vec3 n2 = texture2DLod(sceneTexture, c - vec2(0.0, texel.y), 0.0).rgb;
        vec3 n3 = texture2DLod(sceneTexture, c + vec2(0.0, texel.y), 0.0).rgb;
        vec3 lw = vec3(0.3, 0.6, 0.1);
        float nmax = max(max(dot(n0, lw), dot(n1, lw)), max(dot(n2, lw), dot(n3, lw)));
        if (dot(col.rgb, lw) > nmax * 1.25 + 0.01) col.rgb = (n0 + n1 + n2 + n3) * 0.25;
        float fade = 1.0 - smoothstep(pixelOutline.z, pixelOutline.w, d);
        col.rgb *= 1.0 - pixelOutline.x * edge * fade;
        return col;
    }
`;

const outlineWGSL = /* wgsl */ `
    uniform pixelOutline: vec4f;
    fn applyPixelOutline(scene: vec4f, uv: vec2f) -> vec4f {
        let size = uniform.sceneTextureSize.xy;
        let texel = uniform.sceneTextureSize.zw;
        let c = (floor(uv * size) + vec2f(0.5)) * texel;
        var col = textureSampleLevel(sceneTexture, sceneTextureSampler, c, 0.0);
        var d = getLinearScreenDepth(c);
        let l = getLinearScreenDepth(c - vec2f(texel.x, 0.0));
        let r = getLinearScreenDepth(c + vec2f(texel.x, 0.0));
        let b = getLinearScreenDepth(c - vec2f(0.0, texel.y));
        let t = getLinearScreenDepth(c + vec2f(0.0, texel.y));
        let gap = 0.1 * d + 0.1;
        if (l < d - gap && r < d - gap) {
            col = textureSampleLevel(sceneTexture, sceneTextureSampler, c - vec2f(texel.x, 0.0), 0.0);
            d = min(l, r);
        } else if (b < d - gap && t < d - gap) {
            col = textureSampleLevel(sceneTexture, sceneTextureSampler, c - vec2f(0.0, texel.y), 0.0);
            d = min(b, t);
        }
        let l2 = min(l, getLinearScreenDepth(c - vec2f(2.0 * texel.x, 0.0)));
        let r2 = min(r, getLinearScreenDepth(c + vec2f(2.0 * texel.x, 0.0)));
        let b2 = min(b, getLinearScreenDepth(c - vec2f(0.0, 2.0 * texel.y)));
        let t2 = min(t, getLinearScreenDepth(c + vec2f(0.0, 2.0 * texel.y)));
        let thr = uniform.pixelOutline.y * d + 0.04;
        let edge = max(
            step(thr, max(l2, r2) - d) * step(thr * 0.5, (l2 + r2) * 0.5 - d),
            step(thr, max(b2, t2) - d) * step(thr * 0.5, (b2 + t2) * 0.5 - d)
        );
        let n0 = textureSampleLevel(sceneTexture, sceneTextureSampler, c - vec2f(texel.x, 0.0), 0.0).rgb;
        let n1 = textureSampleLevel(sceneTexture, sceneTextureSampler, c + vec2f(texel.x, 0.0), 0.0).rgb;
        let n2 = textureSampleLevel(sceneTexture, sceneTextureSampler, c - vec2f(0.0, texel.y), 0.0).rgb;
        let n3 = textureSampleLevel(sceneTexture, sceneTextureSampler, c + vec2f(0.0, texel.y), 0.0).rgb;
        let lw = vec3f(0.3, 0.6, 0.1);
        let nmax = max(max(dot(n0, lw), dot(n1, lw)), max(dot(n2, lw), dot(n3, lw)));
        if (dot(col.rgb, lw) > nmax * 1.25 + 0.01) {
            col = vec4f((n0 + n1 + n2 + n3) * 0.25, col.a);
        }
        let fade = 1.0 - smoothstep(uniform.pixelOutline.z, uniform.pixelOutline.w, d);
        col = vec4f(col.rgb * (1.0 - uniform.pixelOutline.x * edge * fade), col.a);
        return col;
    }
`;

const posterizeGLSL = /* glsl */ `
    uniform float pixelLevels;
    vec3 applyPixelPosterize(vec3 color, vec2 uv) {
        return floor(clamp(color, 0.0, 1.0) * pixelLevels + 0.5) / pixelLevels;
    }
`;

const posterizeWGSL = /* wgsl */ `
    uniform pixelLevels: f32;
    fn applyPixelPosterize(color: vec3f, uv: vec2f) -> vec3f {
        return floor(clamp(color, vec3f(0.0), vec3f(1.0)) * uniform.pixelLevels + vec3f(0.5)) / uniform.pixelLevels;
    }
`;

export class PixelOutlineEffect extends CameraFrameEffect {
    /** How much a silhouette texel is darkened (0–1). */
    strength = 0.55;
    /** Depth jump, as a fraction of the distance, that counts as a silhouette. */
    threshold = 0.06;
    fadeStart = 25;
    fadeEnd = 60;

    constructor(device: GraphicsDevice) {
        super(device, 'pixelOutline', {
            slot: COMPOSESLOT_SCENE,
            requires: [FRAMERESOURCE_DEPTH],
            glsl: outlineGLSL,
            wgsl: outlineWGSL
        });
    }

    update(): void {
        this.setUniform('pixelOutline', [this.strength, this.threshold, this.fadeStart, this.fadeEnd]);
    }
}

export class PixelPosterizeEffect extends CameraFrameEffect {
    /** Levels per colour channel. */
    levels = 14;

    constructor(device: GraphicsDevice) {
        super(device, 'pixelPosterize', { slot: COMPOSESLOT_OUTPUT, glsl: posterizeGLSL, wgsl: posterizeWGSL });
    }

    update(): void {
        this.setUniform('pixelLevels', this.levels);
    }
}

export interface PixelLook {
    readonly enabled: boolean;
    set(on: boolean): void;
}

/** Size of one game pixel in screen pixels (CSS pixels × device ratio is not considered). */
const PIXEL_SCALE = 0.25;

/** Adds the look's effects to a camera frame, off; `set` turns it on and off. */
export function addPixelLook(device: GraphicsDevice, frame: CameraFrame, samples: () => number): PixelLook {
    const outline = new PixelOutlineEffect(device);
    const posterize = new PixelPosterizeEffect(device);
    outline.enabled = false;
    posterize.enabled = false;
    frame.addEffect(outline);
    frame.addEffect(posterize);
    const saved = { bloom: frame.bloom.intensity, vignette: frame.vignette.intensity };
    let enabled = false;
    return {
        get enabled() {
            return enabled;
        },
        set(on: boolean) {
            if (on === enabled) return;
            enabled = on;
            outline.enabled = on;
            posterize.enabled = on;
            frame.rendering.renderTargetScale = on ? PIXEL_SCALE : 1;
            frame.rendering.samples = on ? 1 : samples();
            frame.bloom.intensity = on ? 0 : saved.bloom;
            frame.vignette.intensity = on ? 0 : saved.vignette;
            frame.update();
        }
    };
}
