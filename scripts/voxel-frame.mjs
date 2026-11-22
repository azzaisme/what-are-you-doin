// Prints the settings menu's frame (src/style.css, --menu-frame) as a CSS data URI: a 16x16-voxel
// 9-slice with stepped corners built up in hard-hat yellow, a 1-voxel outline and a bevel lit
// top-left and shaded bottom-right. Slice it 6 voxels from each edge; the middle stretches.
//   node scripts/voxel-frame.mjs            (the frame)
//   node scripts/voxel-frame.mjs corners    (the corner caps)
const N = 16;
const NOTCH = [3, 2, 1]; // voxels cut from each corner, per row
const C = {
    fill: '#141b22',
    outline: '#05080b',
    lit: '#3b4855',
    shade: '#0a0f14',
    corner: '#f2c14e',
    cornerLit: '#ffdc7a',
    cornerShade: '#b8862a'
};
const inside = (x, y) =>
    [
        [x, y],
        [N - 1 - x, y],
        [x, N - 1 - y],
        [N - 1 - x, N - 1 - y]
    ].every(([cx, cy]) => !(cy < NOTCH.length && cx < NOTCH[cy]));
const out = (x, y) => x < 0 || y < 0 || x >= N || y >= N || !inside(x, y);
const near = (x, y, d) => {
    for (let dy = -d; dy <= d; dy++) for (let dx = -d; dx <= d; dx++) if (out(x + dx, y + dy)) return true;
    return false;
};
const col = (x, y) => {
    if (!inside(x, y)) return null;
    const dx = Math.min(x, N - 1 - x);
    const dy = Math.min(y, N - 1 - y);
    // the corners are built up: yellow brackets along both edges of each corner slice, three voxels
    // thick at the inner step
    const corner = dx < 6 && dy < 6;
    const lit = x + y < N - 1;
    if (near(x, y, 1)) return corner ? (lit ? C.corner : C.cornerShade) : C.outline;
    if (near(x, y, 2)) return corner ? (lit ? C.cornerLit : C.cornerShade) : lit ? C.lit : C.shade;
    if (near(x, y, 3) && corner && dx + dy <= 6) return lit ? C.corner : C.cornerShade;
    return C.fill;
};
let rects = '';
for (let y = 0; y < N; y++) {
    for (let x = 0; x < N;) {
        const c = col(x, y);
        if (!c) {
            x++;
            continue;
        }
        let w = 1;
        while (x + w < N && col(x + w, y) === c) w++;
        rects += `<rect x='${x}' y='${y}' width='${w}' height='1' fill='${c}'/>`;
        x += w;
    }
}
const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${N}' height='${N}' viewBox='0 0 ${N} ${N}' shape-rendering='crispEdges'>${rects}</svg>`;
if (process.argv[2] !== 'corners')
    console.log(
        `url("data:image/svg+xml,${encodeURIComponent(svg).replace(/%20/g, ' ').replace(/%3D/g, '=').replace(/%3A/g, ':').replace(/%2F/g, '/').replace(/%27/g, "'").replace(/%3C/g, '<').replace(/%3E/g, '>')}")`
    );

// Corner caps (--menu-corners): L-shaped yellow blocks, 11 voxels long and 5 thick, extruded towards
// the viewer: the yellow face on top, D voxels of depth going down-right (a mid side face on the
// right, the darkest face underneath) and a shadow cast on the frame. The light is from the top left
// on all four corners; only the L is mirrored.
const M = 11;
const T = 5;
const D = 3; // extrusion depth (voxels)
const S = M + D + 1; // image size: the face, its depth and its shadow
const inCap = (x, y) => x >= 0 && y >= 0 && x < M && y < M && (x < T || y < T) && !(y < 2 && x < 2 - y);
const capCells = (flipX, flipY) => {
    const face = (x, y) => inCap(flipX ? M - 1 - x : x, flipY ? M - 1 - y : y);
    // where the face was pushed from, for a cell in its depth (null: not in the block)
    const origin = (x, y, depth) => {
        for (let k = 1; k <= depth; k++) if (face(x - k, y - k)) return [x - k, y - k];
        return null;
    };
    const solid = (x, y) => face(x, y) || origin(x, y, D) !== null;
    const cells = new Map();
    for (let y = 0; y < S; y++)
        for (let x = 0; x < S; x++) {
            let c = null;
            if (face(x, y)) {
                const edge = !solid(x - 1, y) || !solid(x, y - 1) || !solid(x + 1, y) || !solid(x, y + 1);
                if (edge) c = C.outline;
                else if (!face(x - 1, y - 1) || !face(x, y - 2) || !face(x - 2, y)) c = C.cornerLit;
                else c = C.corner;
            } else {
                const o = origin(x, y, D);
                if (o) {
                    const edge = !solid(x + 1, y) || !solid(x, y + 1) || !solid(x + 1, y + 1);
                    // under the face: the underside (darkest); beside it: the right side
                    let above = false;
                    let left = false;
                    for (let j = 1; j <= D; j++) {
                        above ||= face(x, y - j);
                        left ||= face(x - j, y);
                    }
                    if (edge) c = C.outline;
                    else c = left && !above ? C.cornerShade : '#7a5414';
                } else if (origin(x, y, D + 1)) c = 'rgba(0,0,0,0.45)'; // the cast shadow
            }
            if (c) cells.set(`${x},${y}`, c);
        }
    // the bolt, in the corner block
    const bx = flipX ? M - 3 : 2;
    const by = flipY ? M - 3 : 2;
    cells.set(`${bx},${by}`, '#6e4c12');
    cells.set(`${bx + 1},${by + 1}`, '#ffe9a8');
    return cells;
};
const svgOf = (cells, n) => {
    let r = '';
    for (const [k, c] of cells) {
        const [x, y] = k.split(',');
        r += `<rect x='${x}' y='${y}' width='1' height='1' fill='${c}'/>`;
    }
    return `<svg xmlns='http://www.w3.org/2000/svg' width='${n}' height='${n}' viewBox='0 0 ${n} ${n}' shape-rendering='crispEdges'>${r}</svg>`;
};
const enc = (svg) =>
    `url("data:image/svg+xml,${encodeURIComponent(svg)
        .replace(/%20/g, ' ')
        .replace(/%3D/g, '=')
        .replace(/%3A/g, ':')
        .replace(/%2F/g, '/')
        .replace(/%27/g, "'")
        .replace(/%3C/g, '<')
        .replace(/%3E/g, '>')}")`;
if (process.argv[2] === 'corners') {
    const caps = [
        [false, false, 'top left'],
        [true, false, 'top right'],
        [false, true, 'bottom left'],
        [true, true, 'bottom right']
    ];
    console.log(caps.map(([fx, fy, pos]) => `${enc(svgOf(capCells(fx, fy), S))} ${pos} no-repeat`).join(', '));
}
