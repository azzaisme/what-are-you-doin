# (Un)civil Engineers
## Game design, visual technology specification & Claude Code handover

**Tagline:** Civil engineering. Uncivil physics.

**Visual thesis:** A world where matter is pixelated, but light isn't.

**Status:** Proposed greenfield design, v0.1 — 19 November 2026. This document is the implementation brief, not evidence that any code or prototype already exists.

---

## 0. Read this first — instructions for Claude Code

Build a first-person, fully 3D cooperative physics construction game for desktop browsers. Players are chunky voxel beavers, driving a ute through a single continuous valley and building improvised bridges to deliver a bucket of water to a flower. The world actively sabotages their attempts. The signature feature is a universal, world-anchored 10 cm voxel grid: moving objects are **redrawn into the grid**, not rendered as rotating collections of cubes. Underlying physics remains continuous. Reflections, lighting, camera movement and atmospheric effects remain smooth and beautiful.

**Start with Epic 0 and Epic 1 only. Do not build the full game immediately.** The visual premise is the largest differentiation and technical risk. Prove it in motion before committing to content production. Build a small, runnable, measurable demo; ask the owner to approve its visual direction at the first gate. No need for a network server, full map, menus, inventory, procedural terrain or destructibility in that demo. Design clean boundaries so these can be added later.

### Decision hierarchy

- **Owner decisions / established brief:** title, engineering game rather than a Kingdom clone, fully 3D first-person gameplay, world-fixed voxel reconstruction, 10 cm cubes, beautiful continuous lighting and reflections, janky physics, beaver protagonists (latest preferred direction), PlayCanvas/Claude-oriented development, one handcrafted journey rather than a roguelike, desktop browser target. Preserve the earlier goal of single player, up to seven friends (eight total) and two-player local co-op; local input details remain to be validated.
- **Recommended working defaults:** TypeScript, Rapier, Colyseus, 60 Hz simulation, 20 Hz voxel reconstruction, WebGL2 baseline, planar river reflections, flower as delivery target, proposed systems, control mappings, progression and budgets below. These can be changed after a measured prototype or owner review.
- **Unresolved:** exact hardware baseline, final player scale, whether the 10 cm grid has any authored exceptions beyond water/atmosphere/UI, art palette, checkpoint generosity, dedicated hosting, local split-screen constraints and commercial scope. Do not silently turn proposed values into fixed product requirements.

### Agent workflow

1. Inspect the existing repository and its instructions, if present. Do not overwrite work. If empty, use the bootstrap below.
2. Make a short plan and implement one vertical slice at a time. Keep each increment runnable. Use official documentation for the installed library versions instead of inventing APIs.
3. Write tests for math, state ownership and game rules; use browser automation and real screenshots for visual acceptance. Never treat a screenshot alone as proof of animation correctness or gameplay fun.
4. Record decisions, benchmark hardware/browser, commands, screenshots and known issues in `docs/progress.md`. Maintain `docs/adr/` for architecture changes. Keep the lockfile committed.
5. At each gate report actual passes/failures and numbers, not estimates presented as measurements. Do not implement future epics until the gate is approved. Avoid placeholder systems that pretend to be complete.

---

## 1. Game pitch

Eight allegedly qualified civil engineers are actually beavers. Their assignment: deliver one bucket of water to one flower. The road is broken, the river is rising, and the landscape seems to take personal offence at their work. They must fell trees, machine them into timber, drag, lift and nail pieces together, drive the ute over the result, and improvise when it inevitably goes wrong.

A bridge is not an inventory recipe or a cutscene. It is a collection of actual masses and connections, assembled by players in the world. A questionable bridge may survive; a beautiful one may fail. The comedy comes from the consequences of choices and a deliberately spiteful environment, not controls that randomly ignore input.

### Pillars

| Pillar | Design consequence |
|---|---|
| Engineering by hand | Carry, place, fasten and test real objects; no mandatory blueprint puzzle solution. |
| Cooperative chaos | Two people on one log, multiple useful parallel jobs, no hard requirement for friends to finish. |
| Malicious but learnable world | Hazards target engineering plans; clear tells, recoverable failures and exploitable rules. |
| One silly objective | Protect and deliver a real bucket of water; the flower is the payoff, not a lore-heavy quest. |
| Matter is pixelated | All ordinary visible solid geometry occupies common fixed 10 cm cells. |
| Light is not pixelated | Beautiful water, material response, fog, shadows, reflections and a smooth camera. |

### Non-goals

No RPG combat, crafting tech tree, survival hunger, random roguelike maps, fully destructible voxel terrain, full fluid simulation, Minecraft-style block placement, obligatory mobile support, or massive open-world content at launch. No perfect engineering simulator. No artificial difficulty through input latency. No claim that the voxel method is unprecedented.

### Player experience

First minute: look around a beautiful valley; discover that the ute, timber and other beavers visibly reconstruct as they move. Fill or collect the bucket, load the ute and drive away. First five minutes: meet a small broken crossing, learn to carry and fasten two beams, then test the result. First comedy beat: an avoidable gust, rolling log or collapsing support makes a mess. First triumph: the group drives across its own creation, hopefully with the bucket intact.

---

## 2. Game rules & player interactions

### 2.1 Core loop

Explore road → discover an obstacle → survey stable supports → gather and process timber → carry and attach pieces → test construction → survive sabotage → recover mistakes → cross in ute → continue towards the flower.

Freeform construction must allow multiple plausible solutions. Progress is spatial: players can look back at structures they built. There is one authored main route with local alternatives; the game is not a series of reset rooms.

### 2.2 Players and camera

- First-person mouse-look camera with smooth, continuous transform; optional third-person/debug view for testing the art and observing characters. No mandatory head bob, camera shake or quantized camera movement. Adjustable FOV and sensitivity; reduce-motion toggle.
- Beavers, starting target height 1.4 m (14 cells), with blocky body, big flat tail, two buck teeth, tiny ears, hard hat and high-vis accents. Silhouette and colour distinguish them at a distance. No conventional rotated voxel limbs in final rendering.
- Underlying animation uses simple joint hierarchies or primitive volumes. Evaluate pose, then rasterize into the shared grid. A walk cycle may be authored as a few poses and interpolated underneath. No need to model individual fur hairs.
- Responsive walking, running, jump/step-up, crouch, swimming or wading, grab/release and tool actions. Prefer a controllable avatar not permanently flopping. Ragdoll only on strong impacts or explicit comic events; recover automatically or on input.
- First-person hands/tools: world-space voxelized visible geometry (exclude own head/body from first-person camera as necessary). Avoid camera-space viewmodels that violate the fixed world-grid rule. HUD crosshair and text are exceptions.

### 2.3 Proposed controls (remappable)

| Input | Action |
|---|---|
| WASD / mouse | Move / look |
| Space / Shift / Ctrl | Jump / sprint / crouch |
| E | Interact, enter/exit seat, operate machine |
| Left mouse | Grab/release or tool primary action, context permitting |
| Right mouse | Secondary hand / hold orientation control |
| Mouse wheel | Adjust held-object reach within limits |
| R | Rotate held object while in placement mode |
| F | Fasten with equipped tool when valid |
| Q | Drop or cancel |
| Tab | Quick tools / status |
| Esc | Pause solo or open settings; releases pointer lock |

Explicit action prompts must explain which context is active. Vehicle uses WASD, space brake, E exit. Controller mappings for local co-op are to be designed later; two people should not be forced to share mouse input.

### 2.4 Object handling and cooperation

Target physical grabbing with a damped spring/constraint to an offset point in front of player, limited by reach, force and torque. Never directly teleport a held dynamic object every frame. Acquire via raycast; validate occlusion, distance, allowed object type, and capacity. Attachment anchors are local to the physical body. Update target using player pose. Multiple players can grab different anchors of the same object; combine bounded forces on a single authoritative body. Release on disconnect, death, excessive stretch or explicit drop. Avoid forces growing with frame rate and avoid feedback loops with player collision.

Heavy objects are easier with two players; solo player can use a winch, lever, movable stand, lighter material or cut pieces. No puzzle requires exactly two humans. Carrying is an emergent teamwork task, not a synchronized button prompt. Provide useful roles: driver, timber cutter, machine operator, rigger, builder, spotter, bucket guardian.

### 2.5 Forestry and material processing

Trees have rooted trunks with simple collision, a cut state and a falling phase. Chopping/chewing/axe advances a cut indicator. When cut completes, create or switch to a dynamic trunk once; apply an initial directional bias based on cut direction and weight; warn players of fall. A fallen trunk is a transportable physical log. Remove or simplify foliage collision. Visual wood chips are bounded pooled voxel effects, not unlimited rigid bodies.

Portable or roadside sawmill accepts one compatible log in a guide zone. Interlock feeding so the same log cannot be processed twice. Show progress, audible feedback and moving machine parts (also voxelized). Consume log and output individual physical planks and optional beams. Starting sizes are multiples of 0.1 m, e.g. 2.4 × 0.2 × 0.1 m plank and 3.0 × 0.3 × 0.3 m beam; tune for crossing scale. Outputs are positioned clear of other bodies. Avoid an abstract crafting grid as the primary loop.

### 2.6 Building and failure

Construction is a joint graph, not a fixed building grid. Visual cells are grid-aligned; physical pieces can be positioned and oriented anywhere. A snapped visual cell does not imply a structural connection. Stable ground, prepared abutments and supports are anchor candidates. Use connection previews, local contact tests, alignment tolerance and a nail/bolt tool. Connections store body IDs, local anchors, type, stiffness, strength and fatigue. Prevent duplicate links and fastening through impossible gaps. A nail is a data connection with a tiny visual marker if legible; it need not be a physical rigid body or a literal smaller voxel.

Start with a rigid/fixed joint between timber pieces and explicit breakage logic. Determine how to obtain or estimate joint loading using the installed Rapier API; do not assume native break thresholds or solver impulses are exposed. If direct forces are unavailable, prototype a calibrated approximation using relative strain, reaction estimates, impact impulses and sustained load. Show creaks, bent/shifted pieces and warning sounds before typical failure. Remove joints safely after the physics step, replicate topology change and allow debris to settle. Limit collision between attached pieces where necessary; test wake/sleep behavior and secondary failures.

**Important vehicle constraint:** raycast wheel suspension must detect load-bearing *dynamic* bridge pieces, not just terrain. Test force transfer both directions; a vehicle resting on a plank must load the plank, not merely receive support from a one-way raycast. If the installed controller cannot do this adequately, implement reciprocal suspension/contact forces or evaluate wheel colliders. This is a gate, not assumed solved.

### 2.7 Ute

A small shared pickup with arcade off-road handling, physical chassis, wheel visual volumes, suspension, steering and braking. Driver has authoritative seat assignment; passengers have seats or later safe riding interactions. Cargo bed is a physical space: timber and bucket can slide, bounce or fall out. Optional tension straps act as bounded constraints. No automatic teleport of all cargo with vehicle transform. Vehicle recovery points or a winch prevent losing the run to an overturned truck. The wheel visuals independently follow suspension/spin poses before voxelizing; keep physics and rendering separate.

### 2.8 Bucket and water

A physical bucket with handle, collision shape and persistent water volume in litres (capacity proposed 10 L). Track an internal slosh state driven by gravity in bucket-local coordinates, translational acceleration and angular motion. A damped oscillator plus overflow test at rim is enough; do not simulate per-water-voxel physics. Spill reduces authoritative volume; validate bounds [0, capacity], and use fixed-step integration. Render an attractive water surface clipped to bucket shape, plus bounded decorative voxel droplets. Water mass contributes to bucket mass; adjust coarsely if changing mass frequently destabilizes joints. A spill is irreversible except by refilling from designated clean sources. No visual particle count is authoritative water volume.

Proposed victory requires any meaningful amount (e.g. 0.25 L, tune after tests) poured into summit flower. Give positive feedback for arriving with more water but don't demand perfection. If empty, recover via refill points (limited and placed intentionally). Don't make players replay forty minutes solely because the renderer glitched or the game disconnected them.

### 2.9 World is out to get you

The jam theme matters: not just natural chaos. The world must respond maliciously to attempts at success. A deterministic or server-seeded hazard director schedules authored events from gameplay conditions, not arbitrary per-frame random destruction.

| Hazard | Tell | Counterplay |
|---|---|---|
| Rising river after construction | Siren, level marks, upstream rumble | Elevate bridge, act quickly, add supports |
| Wind aimed at carried plank | Leaves, wind sock, warning gust | Lower plank, carry together, brace |
| Tree falls towards ute | Lean and cracking before release | Cut from safe position, move ute, use rope |
| Handbrake prank on slope | Ratchet click / dashboard warning | Chock wheels, park flat, secure line |
| Overweight vehicle approaches | Horn and warning sign | Block lane, reinforce bridge, wait |
| Road closure sign swaps | Mechanical clunk and readable sign | Find side route / manually move barrier |
| Goose attacks bucket bearer (optional) | Honk and visible approach | Put bucket down, distract, dodge |

One event must create a meaningful response, rather than automatically deleting the player's work. Give cooldowns, severity budget and safe windows; disable overlapping events that remove every recovery option. World events can be comically impossible, but should have consistent rules. Implement two strong hazards first.

### 2.10 Recovery and persistence

Use authored checkpoint regions after crossings, not arbitrary rewind each failure. Save route progress, safe player/vehicle recovery positions and key world/bucket state. Decide after playtest whether bridge state persists through checkpoint recovery. For solo, recover local save; for online, server owns checkpoint and session state. Initially session-only persistence is acceptable; later versioned snapshots. Disconnect cleans seats, grabs and tools. Always provide a way to recover essential items; limit exploits without removing funny player freedom.

---

## 3. World and art direction

### 3.1 Route concept (proposed, do not build yet)

One continuous scenic mountain valley, viewed in first person. Start at a timber yard or peaceful village with the goal silhouetted on distant ridge. A coherent route follows rivers, forestry roads, bridges and machinery. No procedurally generated roguelike run.

| Area | New engineering skill | Signature view | Escalation |
|---|---|---|---|
| Timber yard | Grab, sawmill, fastening, load ute | Early sunrise over river | Small rolling log |
| Shallow creek | Simple beam-and-plank span | Clear water and reeds | Rising water |
| Forest road | Transport long beams | shafts of sunlight, moss | falling trees/wind |
| Gorge | Braced long span, winch | deep ravine and waterfall | strong gusts |
| Old industrial works | Heavy cargo, movable platforms | warm metal reflections | machinery interference |
| Mountain approach | Combined skills | alpine fog, distant summit | selected compound hazards |
| Flower summit | Protect final drops | golden-hour payoff | final comic beat, then relief |

First vertical slice is just the timber yard and shallow creek. Later areas are options, not scope promises. Aim for gameplay that works in ten minutes before expanding to a full one-hour journey. Keep roads large enough for turning and maneuvering, banks accessible, and fallen materials recoverable.

### 3.2 Visual identity

Kingdom is a reference for carefully chosen colour and atmosphere, not camera/gameplay. Teardown is a reference for lighting and voxel material richness, not the proposed dynamic world-grid algorithm. Beavers should resemble sculpted pixel characters, not highly detailed human avatars. A unified 10 cm scale makes each cube visible: a 1.4 m player has just 14 cells of vertical space. Do not use 2–4 cm micro-voxels for character details or quietly add rounded limbs. Important silhouettes must work at that resolution.

Natural saturated-but-restrained forest greens, warm timber, rich cool shadows, turquoise/blue river, golden sunlight, high-vis orange/yellow accent. Rough wood, damp mud, metallic toolheads, smooth water; lighting does the visual sophistication. Faces: contrasting muzzle, two teeth, small dark eyes, short ears, broad tail. Use palette variation anchored to asset-local material fields, not unstable world-cell random colours that flicker when moving. Avoid noisy outlines, gaps between every cube, random bevels and screen pixelation. Voxel surfaces should be contiguous flat square faces, with stepped silhouettes and face-level colour variation.

### 3.3 Strict visual contract

1. All ordinary visible solid world geometry lies on a single global grid, axis-aligned to XYZ, with cell edge `s = 0.1 m`.
2. Static and dynamic objects use the same origin and grid. No per-object shifted or rotated render grid. Moving a cube-shaped object diagonally activates other cells. Rotating a plank produces a stepped silhouette; rendered cube faces never rotate.
3. Renderer occupancy is transient. Rebuild / change active cells, not physical bodies, and never allocate an engine entity per voxel. Traditional continuous physics shapes are hidden except in debug.
4. Camera, shading, gradients, shadows, reflections and atmospheric effects remain full-resolution and smooth. No pixelated screen filter. A smooth directional light can move while geometry is held for a voxel frame.
5. Proposed explicit exceptions: water surface (including inside bucket), fog/clouds/light shafts, sky, UI/reticles and debug overlays. Droplets, most debris and solid particle silhouettes remain world-grid aligned. Ropes or thin nails must be represented by grid-aware thickened proxies or deliberately approved exceptions; do not invent sub-grid solids quietly.

---

## 4. Implementation stack and architecture

### 4.1 Recommended stack

PlayCanvas standalone engine + TypeScript + Vite for client; Rapier 3D WASM for independent physics; Colyseus on Node.js for authoritative online rooms; Vitest for pure math/systems and Playwright for browser tests. Start with WebGL2, use WebGPU only as optional measured extension. No built-in Ammo rigid bodies in parallel with Rapier. Verify installed library APIs and pin working versions; avoid untested new engine features in the critical path.

The game should run as static client assets on itch.io or equivalent. Online multiplayer uses a separately hosted HTTPS/WSS Node server. Solo should work without it. Desktop packaged build can be considered later; no current Steam packaging promise. No mobile feature budget.

### 4.2 Boundaries

```
Input devices -> Commands -> Shared simulation (Rapier, gameplay)
                                  |
                             Pose / events
                                  |
                   Client pose sampling / interpolation
                                  |
                         World-grid rasterizer
                                  |
                  Chunk meshes / instanced voxel buffers
                                  |
                    PlayCanvas lighting / water / camera
```

Online: server runs shared simulation and sends stable entity IDs, transforms, joint topology, animation state and gameplay events. Clients synthesize visual occupancy locally; do not network thousands of cells per moving body. Solo uses same command/snapshot interfaces with a local simulation implementation. Rendering never becomes gameplay authority; visual occupancy overlap does not generate collisions. The server does not load PlayCanvas or require GPU. Save data excludes render caches.

### 4.3 Proposed repository layout (evolve after Epic 1)

```
uncivil-engineers/
  package.json                 # workspaces after Epic 2/3
  apps/
    client/
      src/
        main.ts
        render/                # scene, camera, lights, materials
        voxels/                # lattice, volumes, rasterization, mesh buffers
        input/
        debug/
        levels/
        net/
        ui/
    server/                    # add at multiplayer epic
  packages/
    sim/                       # add/extract shared Rapier + game rules
    protocol/                  # commands, snapshots, IDs, events
  assets/                      # original source data + licences
  docs/
    GAME_DESIGN.md
    progress.md
    adr/
  tests/
  README.md
```

At first the official scaffold may be a single app; retain that until the visual demo works. Avoid scaffolding empty packages prematurely. Renderer and simulation imports must remain one-way via shared data, not engine objects passed across boundaries.

### 4.4 Time model

Fixed simulation step 1/60 s, accumulated wall time with capped catch-up (e.g. max 4 steps per render or measured equivalent). Rendering uses display refresh; interpolate physics poses between snapshots, then sample those poses on a global voxel update clock. Start 20 Hz; compare 12, 20, 30, 60 Hz. All visible solids should use consistent visual time, including seated characters and held items. Dynamic voxel meshes, shadow casters and reflected geometry must update coherently on the same voxel frame. Camera is independently smooth, with first-person visual mismatch kept bounded. Network snapshots proposed 20 Hz with interpolation and local prediction as needed; measure latency rather than locking this choice.

---

## 5. World-grid voxel renderer — technical specification

### 5.1 Coordinate contract

Use metres, Y up. Define fixed origin `O=(0,0,0)` for first level. Cell index for world position `p` is `floor((p-O)/s)` component-wise; `floor`, not truncation, handles negatives. Cell `(i,j,k)` spans `[O+s*i, O+s*(i+1))` on each axis. Center is `O+s*(index+0.5)`. Cell vertices lie on grid planes. Keep signed integer cell indices for indexing and chunking. Use consistent half-open bounds and tolerances. If floating origin ever becomes necessary, preserve global integer grid IDs and rebase renderer by whole cells only.

A cube of side 0.1 m that translates by 0.04 m might still occupy its original cell; a further shift causes it to disappear and appear in a neighboring cell. A rotating object has continuous physics orientation but newly computed axis-aligned occupancy. Cubes do not themselves slide or rotate. The object's logical identity persists across frames. Exact apparent voxel count need not remain invariant at every orientation, but excessive size changes are unacceptable.

### 5.2 Source volume representation

For demo, use asset-local analytic solids (box, union of boxes, ellipsoid approximations, cylinders) with material IDs. Beaver assembled from simple volumes, truck from boxes and wheel volumes, plank rectangular prism, log cylinder. At runtime sample inverse-transformed world cell positions against these volumes. Later evaluate imported `.vox` / sparse 3D material arrays or signed distance fields (SDFs) for richer models. Version asset schema. Local coordinates and pivots do not need to be grid-aligned; only output does.

Represent animated beaver as parts with local transforms, material ID, occupancy volume and deterministic overlap priority. Parent transform + animation pose yields world transform of each part. Pose sampling then rasterization is identical to vehicles, logs, characters. A static asset can be rasterized once. Source local voxel grids can be sampled as volume fields; naïve forward snapping of source cube centers to world cells is not acceptable as final algorithm (holes, duplicates, inconsistent thickness at diagonal angles).

### 5.3 CPU reference algorithm — start here

For each dirty visible dynamic object/part:

1. Compute conservative world-space AABB of transformed local bounds.
2. Convert AABB to candidate integer cell range using floor(min) and ceil(max)-1, with explicit boundary tolerance.
3. For each candidate cell, map world center into local volume using inverse pose. Evaluate occupancy and material. Start with center sample; add deterministic multisample/analytic intersection only if tests show unacceptable thin-object loss.
4. Map each occupied cell to material and owner/priority in a sparse cell collection. For multi-part assets resolve overlap deterministically (e.g. hat overrides head). For inter-object overlap, use a deterministic policy and record as debug telemetry; avoid drawing two coplanar opaque faces. Static vs. dynamic coverage must be considered for final combined mesh or ownership updates.
5. Compare current and previous occupied cell sets; dirty affected chunks/objects only. For cells removed, restore underlying contributor if present; never accidentally erase a static voxel because a dynamic object left. Keep contributor map or separate occupancy with deterministic compositor.
6. Rebuild exposed faces or update batched instance data; commit all changed buffers atomically before camera/reflection/shadow passes. Do not render transient half-updated chunks.

Pseudocode (logic, not exact library API):

```ts
function rasterize(part: VolumePart, pose: Pose, out: Occupancy): void {
  const aabb = transformBounds(part.bounds, pose);
  const range = candidateCells(aabb, GRID_SIZE, GRID_ORIGIN);
  const inverse = invertPose(pose);
  for (const cell of range) {
    const p = toLocal(cellCenter(cell), inverse);
    const sample = part.volume.sample(p);
    if (sample.occupied) out.write(cell, sample.material, part.priority);
  }
}
```

Use reusable arrays, numeric packed indices within safe ranges or structured chunk keys; avoid string churn and per-cell object allocations in hot paths. For reference tests a slow sparse map is fine; optimize only after profiling. Guard zero/negative scale, invalid transforms, non-finite coordinates, runaway AABBs and arbitrary asset size. Prefer no nonuniform scale initially. Avoid shared mutable temporary math objects that cause subtle corruption.

### 5.4 Thin geometry and temporal stability

A 10 cm board at 45 degrees may miss all center samples over a small region. Options: artist minimum 2 cells across critical visible cross-sections; conservative intersection for boxes; deterministic 2×2×2 sub-sampling with threshold; SDF coverage approximation. Measure trade-off between disappearance and artificial thickening. Choose one policy per asset class if required, documented. Hysteresis between occupancy thresholds can help flicker but can introduce asymmetric motion/history-dependent poses; test before adopting. Never fill holes by rotating cubes. Do not use conventional TAA ghost trails to hide geometry transitions. Ensure material color follows local source, not random per redraw. Keep same-pose and reverse-motion test cases.

### 5.5 Mesh generation and performance progression

Phase A: one instanced cube mesh per small set of materials or a batched mesh with vertex colour, world-aligned matrices, no per-cell entities. Use as correctness and visual reference. Render only surface cells where practical; internal faces otherwise expensive. No gaps between cubes.

Phase B: exposed-face mesher per spatial chunk (start 16^3 or 32^3 cells), material-aware greedy merging of coplanar adjacent faces. Greedy mesh changes triangle layout, not voxel silhouette or material assignment. Use nearest palette sampling/vertex attributes; preserve colour boundaries. Query neighbor occupancy across chunks, mark neighbors dirty when boundary cells change. For final scene, ensure static and dynamic surfaces compose without z-fighting. Consider separate dynamic object buffers first as long as overlaps are rare and tested. Shadow and reflection passes must use the same completed occupancy geometry. Keep buffer capacity and reuse, update changed ranges if supported by installed engine.

Phase C only if profiling requires: worker-based rasterization/meshing with transferable typed buffers and epoch IDs, discard stale results; double-buffer commits; spatial culling, dirty subranges, sleeping object caches, animation pose reuse or optional GPU compute on WebGPU. Static terrain chunk streaming. Do not implement multi-threading or GPU compute before CPU reference is tested. Do not assume browser SharedArrayBuffer is available in an itch.io embed; use transferable buffers baseline.

A grid of 10 cm over a 100 m cube contains 1 billion potential cells: never allocate a dense level-sized 3D array. Use sparse or chunked storage and activation zones. Do not simulate/render far-off inactive objects per frame. Any distance optimization must preserve the same grid on visible silhouettes; use culling / lower update frequency carefully, not secretly bigger cubes or moving per-object transforms. Render camera reflection visibility may differ from main camera; do not cull reflected objects wrongly.

### 5.6 Rendering materials and light

Use standard physically motivated PBR materials, small deliberate palette with roughness/metalness variants, vertex colors or material atlas. Timber matte, wet timber darker/roughness lower, metal highlights, rock grain via cell colour not photographic textures, water specular. Color management: linear lighting and appropriate display tone mapping. Start with one directional sun, ambient sky/IBL, shadow settings tuned for stable contact, AO from rendering or baked geometry data. Add fog, reflected sky, soft shadow filtering, post exposure. Be precise: soft shadows and ambient light can approximate bounce; do not claim true ray-traced global illumination or full SSR unless actually implemented and verified. Aim for polished output with a few reliable techniques, not ten broken effects.

### 5.7 Water and reflections

River is a smooth surface exception: standard continuous normals/ripples, depth tint, Fresnel reflection, shoreline foam, optional refraction/depth effects after capability checks. Implement an actual planar reflection for primary river segment: reflect camera position/orientation against horizontal water plane, render scene to offscreen target excluding water and inappropriate UI/overlays, use clipping to prevent below-plane leakage, select correct winding/culling for mirrored view, sample reflection in water shader with mild normal distortion. Start half resolution and benchmark full resolution. In reflections use world-grid occupancy from the same visual frame, not an ordinary underlying smooth model. Test reflection of moving beaver and rotating plank. No fake static cubemap-only river presented as dynamic mirror. For lower tier, fall back to environment reflection and less expensive shading. General rough metal reflects environment probe; dynamic planar water is primary requirement. SSR optional later, with offscreen and disocclusion limitations. Bucket reflection can use environment sampling rather than a separate camera per bucket. Do not enable reflection camera recursively.

### 5.8 Lighting, shadow and motion settings

Start with golden-hour sun, cool skylight, contact shadows, gentle distance fog and a high-quality sky environment (original or properly licensed). Prototype optional volumetric shafts only after frame budget. Lighting and reflection update each display frame if affordable, voxel occupancy on its own clock. Reduce reflection resolution, light ray steps, shadows or particles before violating visual grid. Continuous camera and discrete geometry need motion tests in first person: nearby carried plank should not appear to intersect the player badly. Debug compare 12/20/30/60 Hz to select comfortable baseline. No smoothing of voxel geometry via mesh transforms between updates.

### 5.9 Validation matrix

| Case | Expected evidence |
|---|---|
| Negative coordinates / chunk seams | Unit tests; no missing or duplicated cells at origin/chunk boundaries |
| Translation 0 to 0.1 m | Cell count and identities change only at occupancy transitions |
| 0°, 15°, 45°, 89°, 90° rotation | All output faces axis-aligned; silhouette approximates shape, no holes above tolerance |
| Repeated identical pose | Identical occupancy/material hashes, no GPU buffer churn |
| Moving two overlapping parts | Deterministic winner; removing winner restores underlying material |
| Thin plank and wheel | No complete disappearance; reasonable thickness/silhouette over full turn |
| Shadow and mirror | Reflect and cast shadows from same reconstructed shape; no hidden smooth mesh |
| First-person moving hand/log | Camera smooth; object remains readable, controllable |
| Long run | Stable object count, buffers, memory; no allocation leak |

---
## 6. Simulation, networking and production risks

### 6.1 Physics model

Rapier owns a continuous world, simplified colliders and stable entity handles. Use static terrain collision, dynamic logs/planks/bucket/chassis, kinematic or controlled dynamic player, sensors for machine and goal interactions. Start with conservative friction, damping, mass ratios, contact tolerances and continuous collision detection on small fast bodies as needed. Keep all lengths/masses realistic in units but tune for fun. Apply impulses through fixed ticks only. Bound interaction forces, collision damage and maximum angular velocity where appropriate; avoid extreme mass ratios and deeply interpenetrating spawn points. Add physics islands/sleeping, distance activation and hard budgets for active bodies. Do not couple render collision to voxel grid.

Build construction stress and vehicle support as independent tested systems. Start with one board, two fixed supports, one load. Add graph breaks and then multi-piece bridge. Test hundreds of runs at same inputs before adding hazards. A broken connection removes joint, not plank, and wakes affected bodies. No blanket deletion of distant player-built bridges unless a later streaming system persists their state.

### 6.2 Multiplayer model

- Online private rooms, up to eight total players; invite code and reconnection. Start with two clients and a local dedicated Node server.
- Server owns physics, object spawn/consume, grabs, attachments, driver seats, water volume, hazards, checkpoints and victory. Clients send sequenced inputs and discrete requests, not trusted final body transforms or direct state mutations.
- Shared protocol includes version, tick, entity ID, transforms/velocities, animation and tool state, bucket volume and connection topology. Event IDs make one-shot audio/particles and spawn/despawn idempotent. Validate all incoming numbers, IDs, rate and ownership. Server processes commands at fixed ticks; snapshots/patches baseline 20 Hz, measure bandwidth. Cap room resources and connection counts.
- Use interpolation buffer for remote and shared objects; player movement prediction and reconciliation where needed. Avoid predicting an entire shared bridge until it is justified by latency testing. A held item may need local visual prediction of target and hand pose, but only authoritative outcomes are committed. All displayed geometry still goes through global voxelization.
- On reconnect send full state + topology, rebuild local render caches. Player leaving releases grabs and seat. Server tick debt, bandwidth and object count are instrumented. Server frame budget separate from browser rendering budget.
- Offline solo uses same simulation and commands via in-process adapter; should work without any backend or login. Local two-player mode proposed as two cameras/controllers against the same world/simulation, not duplicate worlds. Test split-screen performance and browser gamepad behavior later; keyboard/mouse + controller or two controllers. Do not assume combined online and couch co-op until reviewed.

### 6.3 Testing network conditions

Test two, four and finally eight active clients. Introduce representative 40/100/200 ms round-trip delay, jitter, temporary disconnect and reconnect; note WebSocket reliable delivery and possible head-of-line delay. Assertions: no duplicated log outputs; no conflicting seats; no orphaned joints/grabs; same authoritative bucket volume and victory result; bridge collapse topology converges; no permanent divergent body states. Measure subjective grab responsiveness with two people carrying the same log under latency. Use server tick timestamps and client interpolation metrics. A single smooth localhost demo is insufficient.

---

## 7. The starting point — exact first build

### 7.1 Bootstrap

Assume empty repository only after checking. Install Node version compatible with the current scaffolder (official docs currently state Node 22.23.2 or later). Run:

```sh
npm create playcanvas@latest uncivil-engineers -- -f engine
cd uncivil-engineers
npm install
npm install -D vitest @playwright/test
npm run dev
```

Choose a minimal/empty Engine starter if prompted, not React or editor project. Review generated scripts and skills. Confirm `npm run build` works; add a type-check script and `npm run test` if absent, configure a Playwright smoke test. Install Rapier only when needed for Epic 2 (or a minimal physics comparison during Epic 1 after the renderer is working). Keep the scaffold lockfile. Copy this file into `docs/GAME_DESIGN.md` or place at repository root as requested by owner. Set up progress file and Git baseline. No secrets committed.

### 7.2 First scene: The River Lab

A compact 25 × 25 m original scene, not a production level. A shallow river running across the scene, a small flat bank, a few voxel pine trees, rocks, a distant hill silhouette, one beaver, one 2.4 m plank, one log, a simple ute-shaped test object, a bucket and one dynamic cube/sphere proxy. Use a 10 cm grid for everything solid. Start with primitive source shapes, not purchased or generated high-poly assets. Make the view work both in orbit camera and first-person walk mode. The default composition looks across the river at the beaver and test props with golden directional sunlight, soft shadows and cool ambient sky. The mirror in the river should visibly respond to moving objects.

**Build order (finish each before the next):**

1. Grid math + unit tests, static axis-aligned cube/box scene, debug axes.
2. CPU inverse sampling of an animated rotating plank and moving cube; draw with instancing or exposed-face mesh. Add a conventional reference mode only behind debug toggle, never final presentation.
3. Reconstruct log at fixed update rate; include negative positions, diagonal rotations, thin geometry and stable material tests. Use scripted motion, not physics yet.
4. Beaver walk cycle via a few animated volumes; then moving/rotating ute proxy with wheel volumes. All assets share grid. Add simple continuous first-person / orbit camera controls.
5. Compose river bank and trees from static grid meshes; make reflection camera and shading work; add sun, shadows, sky, AO approximation, fog and polish. Ensure camera/reflection/shadow passes see the same reconstructed assets.
6. Profile and tune; instrument memory, active cells, visited sample count, changed cells, triangle count, draw calls, CPU rasterization/mesh/upload timings, frame rate and GPU frame timing where available. Record browser, GPU, viewport and settings.
7. Run tests, capture screenshots and short motion recording if tools support recording. Provide live demo via local dev server. Ask owner to judge visual direction, especially beaver cuteness, size of voxels, diagonal turning, first-person comfort and water.

### 7.3 Debug panel

Visible only in development / explicit debug mode. Include pause, step voxel frame, reset scene, toggle grid lines, show continuous source bounds, select 12/20/30/60 Hz reconstruction, toggle conventional reference mode, select center/conservative sampling experiment, sun angle/time, toggle reflection, set reflection resolution, count 1/10/25 moving objects. Display active cells, sample calls, dirty chunks, exposed faces, render stats and raster times. Disable UI in screenshots with a key. Seed scripted animation so comparisons are reproducible.

### 7.4 Proposed initial acceptance targets (not measured)

- 100% of output solid vertices aligned with global grid within numeric tolerance; no object-level rotation or translation of world-grid render batches.
- No disappearing log/plank throughout a full controlled turn. Compare candidate sampling policies using screenshots and volume/silhouette stability metrics; set quantitative tolerance from baseline and owner approval.
- Moving character and truck clearly demonstrate delete/create cell behavior; camera and lighting remain smooth; dynamic reflections and shadows match visible geometry.
- First scene targets 60 FPS at 1920 × 1080 desktop on an agreed reference machine, with 20 Hz voxel reconstruction. First-pass budget: p95 frame time ~16.7 ms, raster+mesh CPU work ~4 ms per reconstruction in small scene, no periodic >50 ms main-thread stalls. These are goals, not assurances; report actual results and hardware. At least one lower-quality preset if 60 FPS not achievable on baseline.
- Ten-minute demo run does not show unbounded allocation or increasing entity count. Test Chromium first, then Firefox and browser/device combinations agreed for release.
- `npm run build`, type check, unit tests and browser smoke test pass. No unexpected console errors. Document known limitations. **Owner visual approval is an explicit gate.**

### 7.5 First task prompt to copy directly into Claude Code

> Read the entire (Un)civil Engineers design document. Implement Epic 0 and the first two steps of Epic 1 only. Use standalone PlayCanvas + Vite + TypeScript. Create a fixed 0.1 m world lattice, a local box volume and an inverse-transform rasterizer with tests. Render a translating and continuously rotating plank by activating axis-aligned world cells; do not rotate a voxel mesh or spawn one Entity per voxel. Provide pause, step and a conventional reference comparison in debug. Establish runnable dev/build/test commands. Verify using a browser screenshot and unit tests, report actual results, and stop before networking or construction. In the next increment we will expand the River Lab with a beaver, log, ute, lighting and real planar reflections. Follow the strict visual contract; ask before changing it.

---

## 8. Development roadmap — epics and gates

Each epic ends with a playable demonstration, updated progress file, known risks, tests and owner review. Scope may shrink; do not sacrifice the visual thesis or functional core.

### Epic 0 — Project foundation

Deliverables: official standalone scaffold, strict TypeScript, formatting/lint, lockfile, development command, build, tests, basic Playwright boot, documented environment and source docs. Establish renderer/sim interfaces as needed, not empty speculative systems. Gate: clean install and build work; local page renders; no unexpected console errors.

### Epic 1 — Pixelated space, continuous light

Deliverables: River Lab as described above, CPU reference rasterizer, batched renderer, grid-aligned static scene, animated beaver/plank/log/ute, debug comparisons, lighting/reflections and profiling. Gate: visual and performance criteria in §7.4. Highest-risk technical question: can this look distinctive without excessive flicker or CPU/GPU cost? If no, iterate on sampling, update rate and draw batching; do not silently replace with ordinary rotating voxel models.

### Epic 2 — Physical sandbox (offline)

Install pinned Rapier package. Connect fixed-step simulation and pose adapter to renderer. Add controllable first-person character, safe contact/step behavior, basic grab/release and force bounds, logs and planks, bounce/throw tests, ragdoll experiment, static/dynamic terrain collision, bucket proxy. Gate: 10-minute interactive playground with responsive movement, no physics/render coupling, held props don't cause uncontrolled explosions, stable fixed tick. Implement a scripted physics test for moving and dropping an object; capture grid output at rotations. No networking required yet, but command API must support it.

### Epic 3 — Cooperative shared object proof

Extract shared simulation into package, setup Colyseus room + protocol, separate server and client dev commands, local adapter and network adapter. Add second beaver, player animation state, interpolation, shared-grab constraints, disconnect cleanup and latency debug. Gate: two humans/clients carry opposite ends of one log with believable response; authority and visual grid stay consistent. Test latency and invalid command requests. Single-player offline still works. Do not defer this risk until after a giant world is built.

### Epic 4 — Ute and hauling

Driveable chassis, suspension, dynamic wheel render pose, seats, steering/brake/traction, cargo bed, load/unload, basic recovery, dynamic wheel support tests. Gate: two players load a log and bucket proxy, drive over static AND movable platform, vehicle applies load to supporting body, passengers/seat state sync. Measure wheel support on thin planks; solve before bridge content.

### Epic 5 — Engineering: assemble and break a bridge

Joint graph, valid placement preview, hammer/fastening, connections and stress approximation, break events, structural debug overlay (loads, joints, contacts), reusable supports, simple winch or lever for solo. Gate: properly built small bridge supports loaded ute; underbuilt bridge fails in repeatable and understandable ways; no infinite solver blowup; online joint graph stays correct. Test crossing with 1–4 clients. Provide at least two plausible bridge layouts. If stress approximation is poor, revise solver strategy before content expansion.

### Epic 6 — Logging and sawmill

Tree cut state, predictable falling timber, log carry, machine feed/output, safety interlocks, reusable resource spawns, simple tools. Gate: a tree can become a physical log, two beavers move it, machine produces planks exactly once, and planks work in bridge. Solo alternative viable. No full ecosystem destructibility.

### Epic 7 — Water delivery

Bucket volume, slosh state, fill/spill/pour, visible surface and pooled voxel droplets, volume UI, flower goal, recovery. Gate: stable carry retains volume; abrupt tilt/impact spills; refill works when permitted; online players agree on volume; win triggers once; no NaN, negative water or duplicate refill. Tune difficulty by playtest, not realistic fluid equations alone.

### Epic 8 — The game fights back / first complete vertical slice

Build one compact polished timber-yard-to-creek route, two deliberate hazards with clear counterplay, checkpoint/recovery, objective tutorial, sound and minimal menu. Gate: one player and a two-player team finish a 5–15 minute session without developer intervention, can explain why a failure happened, and can find alternate solutions. Repeat with unfamiliar tester. Demonstrate active sabotage rather than only physics accidents. This is first jam-quality candidate, subject to current eligibility checks.

### Epic 9 — Expand the single journey

Author additional areas one at a time, increasing engineering depth, no procedural roguelike. Add route signs, new silhouettes, side paths, tools, river/weather events, distant visual landmarks. Use chunk streaming and persistent checkpoint design only as required. Gate each area for solo viability, multiplayer recovery and stable performance. Retain prior structures logically; avoid unbounded active bodies. Cut weak areas rather than filling world with repeat chores.

### Epic 10 — Multiplayer scale and release

Scale 2→4→8 clients; private rooms, reconnect, server observability, resource limits, HTTPS/WSS deployment, version compatibility, input remaps, accessibility, controller bindings and local two-player prototype. Split screen is a separate gate because it doubles camera render cost; use shared occupancy, benchmark independent reflections, and choose lower reflection resolution if needed. Local co-op must not be claimed shipped before tested. Test browser itch embed, pointer lock, user-gesture audio, resizing, pause/visibility changes, asset path loading, solo offline mode, server disconnection messaging. Polish UI, sound, victory, tutorial, performance and licensing. Gate: release checklist passed on agreed platforms. Evaluate Steam desktop packaging separately.

---

## 9. UI, sound and accessibility

Keep interface minimal: crosshair, context action, carried-object state, bucket volume, teammate indicators, subtle objective reminder, settings and room status. Use clear text and icon as well as color for structural warnings. Debug strain overlay is not necessarily final UI; normal world communicates through movement, creak and visible joints. Avoid intrusive timers for every task. Clear message when a hazard fires, if its physical tell is insufficient. Allow text scaling, remapping, reduced motion, disable camera shake, separate music/SFX/voice levels, FOV adjustment. Pointer lock acquisition only after user action; clicking menu never grabs a timber piece. Audio: sawmill motor, chopping/chewing, joint creaks, slosh, river ambience, hilarious impact sounds, beaver chatter (nonverbal or optional). Balance loud comedy and peaceful landscape. Use original or properly licensed assets with recorded attribution.

## 10. Validation and scope controls

| Risk | Mitigation / gate |
|---|---|
| Voxel reconstruction too slow | CPU reference then dirty chunks, batches, worker only if measured; test before content |
| Visually noisy or uncomfortable | Same-grid test, temporal sampling tuning, continuous camera, low-noise palette; owner approval |
| Tiny solids vanish | Analytic/thicker proxies, coverage rules, documented exceptions if approved |
| Reflection and shadow passes too expensive | One primary planar camera, resolution presets, coherent occupancy, benchmark |
| Physics/render mismatch | Continuous collision proxy, visible extent tests, bounded grab error, debug overlay |
| Vehicle cannot load dynamic bridge | Reciprocal forces test early, change controller if needed |
| Structural solver inaccurate | Calibrated break logic and repeatable load tests; no unsupported API assumptions |
| Two-player grab under latency | Server authority, damped bounded forces, latency testing before world production |
| Endless debris and structures | sleeping, budgets, chunk activation, save/recovery rules |
| Local/online combined modes expensive | validate separately, preserve architecture without promising launch feature |
| Jam rules and browser hosting constraints | verify current organizer rules, licensing, team/AI/eligibility and external server permissions before submission; deadline not design constraint |

### Release checklist

- Complete first-to-last objective and recover from foreseeable softlocks.
- All required interactions work solo; online advertised player count tested under latency; local mode advertised only if actually complete.
- Global grid visual invariant maintained for moving solids in all camera views; approved exceptions documented.
- Attractive lighting and actual dynamic water reflections enabled on target quality preset.
- No repeated crash, leak, runaway body count or severe console errors in representative playthroughs.
- Build from clean checkout; test and typecheck; reproducible asset and server setup, room compatibility, offline solo.
- itch.io package has static relative asset URLs and contains no secrets; multiplayer backend separate and operational; browser embed verified.
- Credits and third-party licence inventory complete. Verify current jam requirements if submitting; this design is not a ruling on eligibility.

### Decisions not to make without review

Do not swap global lattice for object-local voxels, reduce voxel size for facial detail, add conventional smooth rotating solids to the final game, change first-person to side-view, remove beavers, turn world into random levels, or replace water delivery and freeform engineering with menus. If a performance or usability problem forces such a decision, show measured results and alternatives to owner first.

---

## 11. Technical references and relevant precedents

Use current installed-version docs when implementing; the links below are starting points. No claim is made that this combination is unique across all games.

- PlayCanvas standalone engine + official bootstrap: https://developer.playcanvas.com/user-manual/engine/standalone/
- Official scaffold setup and Node requirements: https://developer.playcanvas.com/user-manual/getting-started/start-with-create-playcanvas/
- PlayCanvas engine source and examples: https://github.com/playcanvas/engine
- Rapier JS controllers, including raycast vehicles: https://rapier.rs/docs/user_guides/javascript/character_controller/ — inspect API and test dynamic support; a sample excluding dynamic objects is not suitable for our bridges.
- Rapier determinism conditions: https://www.rapier.rs/docs/user_guides/javascript/determinism/ — matching versions, initial states, ordering and operations matter; do not depend on lockstep determinism for network authority.
- Colyseus rooms, simulation and patch intervals: https://docs.colyseus.io/room
- Colyseus state synchronization: https://docs.colyseus.io/state
- Film VFX precedent for world-grid character animation: https://www.fxguide.com/fxfeatured/pixels-thinking-outside-the-voxel/ — useful for investigating continuously animated source characters and voxel fields, not a game implementation recipe.
- Aesthetic references: Kingdom (pixel art palettes and atmosphere), Teardown (voxel materials and lighting), Human: Fall Flat (physical comedy), Voxatron (voxel animation); these are references only, not asset sources or instructions to reproduce their gameplay.
- Jam reference supplied by owner: https://itch.io/jam/jamference-ai-game-jam-hack-5 — deadline intentionally ignored for project planning; verify current participation/submission requirements separately.

---

## 12. Definition of success

A stranger watching a ten-second clip should immediately recognize chunky beavers, a questionable bridge, a ute and beautiful water, and notice that the entire solid world reconstructs itself as it moves. A stranger playing the first crossing should immediately understand what to do, laugh when a plan goes wrong, and be able to improvise a successful solution. We can achieve both with a small scene before we need a massive game.

**Build the River Lab first. Prove the visual technology. Prove shared physical interaction next. Then build the game.**
