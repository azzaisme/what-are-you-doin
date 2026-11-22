/**
 * Voxel material palette (design doc §3.2, §5.6).
 *
 * A voxel value is a 16-bit number: material * 4 + shade. Value 0 is empty. Shade (0..3) is a small
 * colour variant chosen from an asset-local material field, so colour follows the object rather
 * than flickering per world cell as it moves.
 *
 * Each material belongs to a surface class, which selects the rendering material (roughness /
 * metalness). Colours are authored in sRGB.
 */

export const SHADES = 4;

export const SurfaceClass = {
    Rough: 0,
    Satin: 1,
    Metal: 2
} as const;
export type SurfaceClass = (typeof SurfaceClass)[keyof typeof SurfaceClass];
export const SURFACE_CLASS_COUNT = 3;

export interface MaterialDef {
    name: string;
    /** Four sRGB shades, 0xRRGGBB. */
    shades: [number, number, number, number];
    surface: SurfaceClass;
    /**
     * Precedence when sub-samples of one cell disagree on material (higher wins). Small details
     * (eyes, nose, teeth, stripes, lights) outrank the surface they sit on, so they are never lost
     * just because the cell centre fell on the other material.
     */
    precedence: number;
}

// Material ids. Keep stable: they are part of asset data.
export const M = {
    Empty: 0,
    Grass: 1,
    GrassDry: 2,
    Dirt: 3,
    Mud: 4,
    Sand: 5,
    Pebble: 6,
    Rock: 7,
    Moss: 8,
    Bark: 9,
    Needle: 10,
    NeedleLight: 11,
    Timber: 12,
    TimberEnd: 13,
    LogBark: 14,
    LogEnd: 15,
    Fur: 16,
    FurDark: 17,
    Muzzle: 18,
    Tooth: 19,
    Eye: 20,
    Nose: 21,
    Tail: 22,
    HardHat: 23,
    HiVis: 24,
    HiVisStripe: 25,
    UtePaint: 26,
    UteTrim: 27,
    Glass: 28,
    Tyre: 29,
    Steel: 30,
    Chrome: 31,
    Galvanised: 32,
    TestOrange: 33,
    TestBlue: 34,
    Reed: 35,
    Headlight: 36,
    Taillight: 37,
    HillGrass: 38,
    HillRock: 39,
    Path: 40,
    Flower: 41,
    Snow: 42,
    Leaf: 43,
    LeafGold: 44,
    LeafRed: 45,
    Splash: 46,
    Dust: 47,
    WindSock: 48,
    BucketWater: 49,
    // people (the lanky stand-in player bodies)
    Skin: 50,
    Workwear: 51,
    Boot: 52,
    // the Valley's old industrial works
    Brick: 53,
    Concrete: 54,
    Rust: 55
} as const;

const defs: MaterialDef[] = [];
function def(id: number, name: string, surface: SurfaceClass, ...shades: [number, number, number, number]): void {
    defs[id] = { name, shades, surface, precedence: 0 };
}

const R = SurfaceClass.Rough;
const S = SurfaceClass.Satin;
const X = SurfaceClass.Metal;

def(M.Empty, 'empty', R, 0, 0, 0, 0);
def(M.Grass, 'grass', R, 0x5d8c3a, 0x588637, 0x63923e, 0x547f35);
def(M.GrassDry, 'grass-dry', R, 0x7c9241, 0x778c3e, 0x82984a, 0x718639);
def(M.Dirt, 'dirt', R, 0x6e5238, 0x654b33, 0x77593d, 0x5c432e);
def(M.Mud, 'mud', S, 0x4f3c2c, 0x483727, 0x564230, 0x413123);
def(M.Sand, 'sand', R, 0xc2ab7d, 0xb8a174, 0xcbb487, 0xae976b);
def(M.Pebble, 'pebble', S, 0x7d8682, 0x6c7672, 0x8d958f, 0x5f6864);
def(M.Rock, 'rock', R, 0x8a8a84, 0x7c7c77, 0x96958e, 0x6f6f6b);
def(M.Moss, 'moss', R, 0x4c6b2a, 0x456226, 0x557530, 0x3e5822);
def(M.Bark, 'bark', R, 0x5a3e2a, 0x513726, 0x634530, 0x4a3222);
def(M.Needle, 'pine-needle', R, 0x2f5a35, 0x2a5230, 0x34623b, 0x264a2c);
def(M.NeedleLight, 'pine-needle-light', R, 0x3f7240, 0x39693a, 0x467a46, 0x336034);
def(M.Timber, 'timber', R, 0xc48d55, 0xb9834e, 0xcd975d, 0xae7a47);
def(M.TimberEnd, 'timber-end', R, 0xdbb07a, 0xd2a670, 0xe3b983, 0xc89c66);
def(M.LogBark, 'log-bark', R, 0x6b4a30, 0x60422b, 0x765236, 0x573c27);
def(M.LogEnd, 'log-end', R, 0xd6ad74, 0xb98d57, 0xe0b97f, 0xa97f4c);
def(M.Fur, 'fur', R, 0x8a5a33, 0x80532f, 0x946137, 0x774d2c);
def(M.FurDark, 'fur-dark', R, 0x5e3b22, 0x56361f, 0x664026, 0x4f321d);
def(M.Muzzle, 'muzzle', R, 0xd9b58a, 0xd2ad82, 0xdfbd93, 0xcaa57a);
def(M.Tooth, 'tooth', S, 0xf4ead2, 0xf4ead2, 0xf4ead2, 0xf4ead2);
def(M.Eye, 'eye', S, 0x16110e, 0x16110e, 0x16110e, 0x16110e);
def(M.Nose, 'nose', S, 0x2a1a14, 0x2a1a14, 0x2a1a14, 0x2a1a14);
def(M.Tail, 'tail', S, 0x3e2e26, 0x352720, 0x47352c, 0x30231d);
def(M.HardHat, 'hard-hat', S, 0xf2c230, 0xf2c230, 0xe9b826, 0xf2c230);
def(M.HiVis, 'hi-vis', R, 0xf26a1b, 0xf26a1b, 0xe8621a, 0xf26a1b);
def(M.HiVisStripe, 'hi-vis-stripe', S, 0xe8e8cf, 0xe8e8cf, 0xe8e8cf, 0xe8e8cf);
def(M.UtePaint, 'ute-paint', S, 0xb3342b, 0xb3342b, 0xa82f27, 0xb3342b);
def(M.UteTrim, 'ute-trim', S, 0x2c2e31, 0x2c2e31, 0x2c2e31, 0x2c2e31);
def(M.Glass, 'glass', S, 0x2d3d4a, 0x2d3d4a, 0x34495a, 0x2d3d4a);
def(M.Tyre, 'tyre', R, 0x1f1f20, 0x1c1c1d, 0x232324, 0x1a1a1b);
def(M.Steel, 'steel', X, 0x9aa0a6, 0x9aa0a6, 0x8f959b, 0x9aa0a6);
def(M.Chrome, 'chrome', X, 0xd7dade, 0xd7dade, 0xd7dade, 0xd7dade);
def(M.Galvanised, 'galvanised', X, 0xa9b0b4, 0x9fa6aa, 0xb3b9bd, 0x979ea2);
def(M.TestOrange, 'test-orange', S, 0xe5732a, 0xe5732a, 0xdc6c26, 0xe5732a);
def(M.TestBlue, 'test-blue', S, 0x2f7fc4, 0x2f7fc4, 0x2b77b9, 0x2f7fc4);
def(M.Reed, 'reed', R, 0x6f8f37, 0x668432, 0x7b9b40, 0x84893f);
def(M.Headlight, 'headlight', S, 0xf6f0d8, 0xf6f0d8, 0xf6f0d8, 0xf6f0d8);
def(M.Taillight, 'taillight', S, 0xd0281f, 0xd0281f, 0xd0281f, 0xd0281f);
def(M.HillGrass, 'hill-grass', R, 0x4f7b3e, 0x47703a, 0x568343, 0x40663a);
def(M.HillRock, 'hill-rock', R, 0x7a7f7c, 0x717673, 0x838885, 0x6a6f6c);
def(M.Path, 'path', R, 0x8e7a5c, 0x857254, 0x968263, 0x7d6b4f);
def(M.Flower, 'flower', R, 0xe85a8a, 0xe85a8a, 0xf2c94c, 0xe85a8a);
def(M.Snow, 'snow', R, 0xeef1f2, 0xe6eaeb, 0xf4f6f7, 0xe0e4e6);
// deciduous crowns and falling leaves (early autumn), particles
def(M.Leaf, 'leaf', R, 0x6f9a3a, 0x648d34, 0x7aa743, 0x5a8030);
def(M.LeafGold, 'leaf-gold', R, 0xd9a32e, 0xcf9828, 0xe3b03c, 0xc48c22);
def(M.LeafRed, 'leaf-red', R, 0xc4542a, 0xb84c25, 0xd06032, 0xa94420);
def(M.Splash, 'splash', S, 0xd8eef0, 0xc6e4e8, 0xe6f6f7, 0xb6dbe0);
def(M.Dust, 'dust', R, 0xb39f80, 0xa89577, 0xbeab8b, 0x9d8a6d);
def(M.WindSock, 'wind-sock', R, 0xf26a1b, 0xe8e8cf, 0xf26a1b, 0xe8e8cf);
// water carried in the bucket: a clear, bright blue so it reads against the galvanised wall
def(M.BucketWater, 'bucket-water', S, 0x3a9ee0, 0x2f8fd2, 0x52b4ee, 0x2a82c2);
def(M.Skin, 'skin', R, 0xd9a47e, 0xcf9a74, 0xe2ae88, 0xc4906b);
def(M.Workwear, 'workwear', R, 0x34405a, 0x2f3a52, 0x3a4763, 0x2a344a);
def(M.Boot, 'boot', R, 0x3b2a1e, 0x35251a, 0x413022, 0x2f2117);
def(M.Brick, 'brick', R, 0x9a4a35, 0x8c4230, 0xa5553e, 0x7e3b2b);
def(M.Concrete, 'concrete', R, 0xa4a199, 0x9a978f, 0xaeaba3, 0x8f8c85);
def(M.Rust, 'rust', S, 0x8a4f2a, 0x7d4625, 0x965a31, 0x6f3e21);

// details that must survive sub-cell placement
for (const [m, p] of [
    [M.Eye, 9],
    [M.Nose, 8],
    [M.Tooth, 8],
    [M.Headlight, 6],
    [M.Taillight, 6],
    [M.HiVisStripe, 5],
    [M.Glass, 3],
    [M.HardHat, 2],
    [M.BucketWater, 4]
] as const) {
    defs[m].precedence = p;
}

export const MATERIALS: readonly MaterialDef[] = defs;
export const MATERIAL_COUNT = defs.length;

/** Voxel value for a material and shade. Shade is wrapped into 0..3. */
export function voxel(material: number, shade = 0): number {
    return material * SHADES + (shade & (SHADES - 1));
}

export function voxelMaterial(value: number): number {
    return value >> 2;
}

export function voxelShade(value: number): number {
    return value & (SHADES - 1);
}

/** Lookup tables indexed by voxel value: packed little-endian RGBA8 (A = 255) and surface class. */
export const VALUE_COUNT = MATERIAL_COUNT * SHADES;
export const VALUE_RGB = new Uint32Array(VALUE_COUNT);
export const VALUE_SURFACE = new Uint8Array(VALUE_COUNT);
export const VALUE_PRECEDENCE = new Uint8Array(VALUE_COUNT);
for (let m = 0; m < MATERIAL_COUNT; m++) {
    const d = defs[m];
    for (let s = 0; s < SHADES; s++) {
        const c = d.shades[s];
        const r = (c >> 16) & 255;
        const g = (c >> 8) & 255;
        const b = c & 255;
        VALUE_RGB[m * SHADES + s] = r | (g << 8) | (b << 16);
        VALUE_SURFACE[m * SHADES + s] = d.surface;
        VALUE_PRECEDENCE[m * SHADES + s] = d.precedence;
    }
}

export function isValidVoxel(value: number): boolean {
    return Number.isInteger(value) && value > 0 && value < VALUE_COUNT && voxelMaterial(value) !== 0;
}
