import { describe, expect, it } from 'vitest';

import type { VoxelAsset } from '../../src/assets/asset.ts';
import { beaverFirstPersonAsset } from '../../src/assets/beaver.ts';
import { personAsset, personFirstPersonAsset } from '../../src/assets/person.ts';
import { bucketAsset } from '../../src/assets/props.ts';
import { getLevel } from '../../src/levels/index.ts';
import { createLabEntities } from '../../src/sim/lab-entities.ts';
import { ANIM_MAX } from '../../src/sim/snapshots.ts';
import { SmoothBuilder, addVolume, volumeSoup } from '../../src/smooth/geometry.ts';
import { RecordingWorld } from '../../src/smooth/recorder.ts';
import { buildSmooth } from '../../src/smooth/smooth-service.ts';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, urlOverrides } from '../../src/ui/settings-store.ts';
import type { SettingsStorage } from '../../src/ui/settings-store.ts';
import { pose } from '../../src/voxels/math.ts';
import { VALUE_COUNT, VALUE_RGB, VALUE_SURFACE } from '../../src/voxels/palette.ts';
import { box, cone, cylinder, ellipsoid } from '../../src/voxels/volumes.ts';
import type { Volume } from '../../src/voxels/volumes.ts';
import type { VoxelWorld } from '../../src/voxels/world.ts';

// "Voxels: Off" (#24): the world and objects as plain smooth meshes, from the voxelizer's own source.

function memory(): SettingsStorage {
    const data = new Map<string, string>();
    return {
        getItem: (k) => data.get(k) ?? null,
        setItem: (k, v) => void data.set(k, v),
        removeItem: (k) => void data.delete(k)
    };
}

/** Every edge of a triangle soup (by exact position), with how many triangles use it. */
function edgeUse(positions: number[]): Map<string, number> {
    const key = (o: number) => `${positions[o]},${positions[o + 1]},${positions[o + 2]}`;
    const use = new Map<string, number>();
    for (let t = 0; t < positions.length; t += 9)
        for (let e = 0; e < 3; e++) {
            const a = key(t + e * 3);
            const b = key(t + ((e + 1) % 3) * 3);
            const k = a < b ? `${a}|${b}` : `${b}|${a}`;
            use.set(k, (use.get(k) ?? 0) + 1);
        }
    return use;
}

/** Signed volume of a closed soup (positive when its faces wind outward). */
function signedVolume(p: number[]): number {
    let v = 0;
    for (let t = 0; t < p.length; t += 9)
        v +=
            (p[t] * (p[t + 4] * p[t + 8] - p[t + 5] * p[t + 7]) -
                p[t + 1] * (p[t + 3] * p[t + 8] - p[t + 5] * p[t + 6]) +
                p[t + 2] * (p[t + 3] * p[t + 7] - p[t + 4] * p[t + 6])) /
            6;
    return v;
}

describe('Voxels: Off (#24)', () => {
    it('the setting: on by default, saved, and ?voxels=off overrides it for a visit', () => {
        expect(DEFAULT_SETTINGS.voxels).toBe(true);
        const store = memory();
        saveSettings(store, { ...DEFAULT_SETTINGS, voxels: false });
        expect(loadSettings(store).voxels).toBe(false);
        saveSettings(store, { ...DEFAULT_SETTINGS, voxels: true });
        expect(loadSettings(store).voxels).toBe(true);
        expect(urlOverrides(new URLSearchParams('voxels=off')).voxels).toBe(false);
        expect(urlOverrides(new URLSearchParams('voxels=on')).voxels).toBe(true);
        expect(urlOverrides(new URLSearchParams('')).voxels).toBeUndefined();
    });

    it('primitives wind outward and are closed', () => {
        const f = () => 4;
        const shapes: Volume[] = [
            box(0.3, 0.2, 0.1, f),
            ellipsoid(0.3, 0.2, 0.25, f),
            cylinder('x', 0.1, 0.5, f),
            cylinder('y', 0.1, 0.5, f),
            cylinder('z', 0.1, 0.5, f),
            cone(0.4, 1.2, f)
        ];
        for (const v of shapes) {
            const s = volumeSoup(v, 0.02);
            expect(signedVolume(s.positions), v.shape.type).toBeGreaterThan(0);
            // each triangle's stored normal agrees with its winding
            for (let t = 0; t < s.positions.length; t += 9) {
                const p = s.positions;
                const ux = p[t + 3] - p[t];
                const uy = p[t + 4] - p[t + 1];
                const uz = p[t + 5] - p[t + 2];
                const wx = p[t + 6] - p[t];
                const wy = p[t + 7] - p[t + 1];
                const wz = p[t + 8] - p[t + 2];
                const n = [uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx];
                const dot = n[0] * s.normals[t] + n[1] * s.normals[t + 1] + n[2] * s.normals[t + 2];
                expect(dot, v.shape.type).toBeGreaterThanOrEqual(-1e-9);
            }
        }
    });

    it('a custom volume is polygonized watertight from its own samples: the bucket stays hollow', () => {
        const bucket = bucketAsset();
        const wall = bucket.parts.find((p) => p.volume.shape.type === 'custom')!;
        const s = volumeSoup(wall.volume, 0.02);
        expect(s.positions.length / 9).toBeGreaterThan(500);
        // closed: every edge is shared by exactly two triangles
        const use = edgeUse(s.positions);
        expect([...use.values()].every((n) => n === 2)).toBe(true);
        expect(signedVolume(s.positions)).toBeGreaterThan(0);
        // hollow: some faces look inward, at the open middle (towards the axis, above the floor)
        const b = wall.volume.bounds;
        const cx = (b.minX + b.maxX) / 2;
        const cz = (b.minZ + b.maxZ) / 2;
        let inner = 0;
        for (let o = 0; o < s.positions.length; o += 3) {
            const dx = s.positions[o] - cx;
            const dz = s.positions[o + 2] - cz;
            if (dx * s.normals[o] + dz * s.normals[o + 2] < -0.5 * Math.hypot(dx, dz)) inner++;
        }
        expect(inner).toBeGreaterThan(100);
        // and the middle of the bucket is not inside its wall
        expect(wall.volume.sample(cx, (b.minY + b.maxY) / 2 + 0.05, cz)).toBe(0);
    });

    it('the only part whose shape evaluate() changes is the bucket water, declared as its fill', () => {
        // Voxels: Off meshes each part once, so a part evaluate() reshapes must say so (partFill). Each
        // part is sampled on a grid in its own frame after evaluate() with all channels 0 and with
        // three other sets of channels; any difference means evaluate() reshaped it
        const assets = new Set<VoxelAsset>([
            ...createLabEntities().entities.map((e) => e.asset),
            beaverFirstPersonAsset,
            personAsset,
            personFirstPersonAsset
        ]);
        let seed = 7;
        const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 10;
        const anims = [
            new Float64Array(ANIM_MAX),
            ...[0, 1, 2].map(() => Float64Array.from({ length: ANIM_MAX }, rand))
        ];
        const reshaped = new Set<string>();
        const declared = new Set<string>();
        for (const a of assets) {
            if (a.parts.length === 0) continue;
            if (a.partFill) declared.add(`${a.name}:${a.parts[a.partFill.part].name}`);
            const poses = a.parts.map(() => pose());
            const shapes = (anim: Float64Array) => {
                a.evaluate(pose(), anim, poses);
                return a.parts.map(({ volume: v }) => {
                    const b = v.bounds;
                    const out: number[] = [];
                    for (let i = 0; i < 8; i++)
                        for (let j = 0; j < 8; j++)
                            for (let k = 0; k < 8; k++)
                                out.push(
                                    v.sample(
                                        b.minX + ((i + 0.5) / 8) * (b.maxX - b.minX),
                                        b.minY + ((j + 0.5) / 8) * (b.maxY - b.minY),
                                        b.minZ + ((k + 0.5) / 8) * (b.maxZ - b.minZ)
                                    )
                                );
                    return out.join(',');
                });
            };
            const rest = shapes(anims[0]);
            for (const anim of anims.slice(1))
                shapes(anim).forEach((s, i) => {
                    if (s !== rest[i]) reshaped.add(`${a.name.replace(/-\d+$/, '')}:${a.parts[i].name}`);
                });
        }
        expect([...reshaped].sort()).toEqual(['bucket:water']);
        expect([...declared]).toEqual(['bucket:water']);
    });

    it('colours come from the volume itself, split by surface class', () => {
        // two values in different surface classes, with different colours: each box's own
        const values = Array.from({ length: VALUE_COUNT }, (_, v) => v).filter((v) => v > 0);
        const a = values.find((v) => VALUE_SURFACE[v] === 0 && VALUE_RGB[v] !== 0)!;
        const b = values.find((v) => VALUE_SURFACE[v] !== 0 && VALUE_RGB[v] !== VALUE_RGB[a])!;
        expect(a).toBeDefined();
        expect(b).toBeDefined();
        const out = new SmoothBuilder();
        addVolume(
            out,
            box(0.1, 0.1, 0.1, () => a),
            null,
            0.02
        );
        addVolume(
            out,
            box(0.1, 0.1, 0.1, () => b),
            { p: { x: 1, y: 0, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 } },
            0.02
        );
        expect(out.triangles).toBe(24);
        const rgba = (v: number) => [VALUE_RGB[v] & 255, (VALUE_RGB[v] >> 8) & 255, (VALUE_RGB[v] >> 16) & 255, 255];
        for (const [v, cls] of [
            [a, VALUE_SURFACE[a]],
            [b, VALUE_SURFACE[b]]
        ]) {
            const c = out.classes[cls];
            // each box's 12 triangles in its own class, every corner in its own colour
            expect(c.indices.length / 3, `value ${v}`).toBe(12);
            for (let i = 0; i < c.vertexCount; i++)
                expect(c.colors.slice(i * 4, i * 4 + 4), `value ${v}`).toEqual(rgba(v));
        }
        // and nothing in the other classes
        const others = out.classes.filter((_, k) => k !== VALUE_SURFACE[a] && k !== VALUE_SURFACE[b]);
        expect(others.every((c) => c.vertexCount === 0)).toBe(true);
    });

    it('the recorder captures what a level builds: ground spec, volumes, single cells, stand trees', () => {
        const yard = getLevel('yard');
        const rec = new RecordingWorld();
        yard.build(rec as unknown as VoxelWorld, 1);
        expect(rec.terrain.length).toBe(1);
        expect(rec.volumes.length).toBeGreaterThan(100);
        expect(rec.cells.length).toBeGreaterThan(100); // reeds and flowers
        const groups = new Set(rec.volumes.map((v) => v.group).filter((g) => g));
        expect(groups.size).toBe(yard.forestry!.trees.length);
    });

    it('a level builds into chunks, one unit per stand tree and stump, and shared part meshes', () => {
        const yard = getLevel('yard');
        const b = buildSmooth(yard, 1);
        const n = yard.forestry!.trees.length;
        expect(b.units.filter((u) => /^stand-\d+$/.test(u.name)).length).toBe(n);
        expect(b.units.filter((u) => /^stump-\d+$/.test(u.name)).length).toBe(n);
        expect(b.units.some((u) => u.name.startsWith('chunk:'))).toBe(true);
        // twenty planks share one mesh per part
        const planks = Object.entries(b.entityParts).filter(([id]) => Number(id) >= 300 && Number(id) < 312);
        expect(new Set(planks.map(([, parts]) => parts.join(','))).size).toBe(1);
        expect(b.partMeshes.length).toBeLessThan(120);
        // every object part has triangles, the bucket's water too: meshed full (its fill), not at
        // the empty level a fresh asset starts at
        const lab = createLabEntities().entities;
        for (const e of lab) {
            const map = b.entityParts[e.id];
            if (!map) continue;
            map.forEach((m, i) => {
                const tris = b.partMeshes[m].reduce((n, c) => n + c.indexCount / 3, 0);
                expect(tris, `${e.name}:${e.asset.parts[i].name}`).toBeGreaterThan(0);
            });
        }
        const bucket = lab.find((e) => e.name === 'bucket')!;
        const fill = bucket.asset.partFill!;
        const water = b.partMeshes[b.entityParts[bucket.id][fill.part]];
        let top = -Infinity;
        let bottom = Infinity;
        for (const c of water)
            for (let i = 1; i < c.vertexCount * 3; i += 3) {
                top = Math.max(top, c.positions[i]);
                bottom = Math.min(bottom, c.positions[i]);
            }
        // from the floor the renderer scales it about, up to the full level (measured: 0.2083 m for
        // 0.2083, and 0.0798 for a floor of 0.08)
        expect(top).toBeCloseTo(fill.level(fill.full), 3);
        expect(bottom).toBeCloseTo(fill.floor, 2);
    }, 120_000);
});
