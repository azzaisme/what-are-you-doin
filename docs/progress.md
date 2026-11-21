# Progress log

## First person: your limbs at 1 cm (2026-11-21, owner report)

Owner, with a phone screenshot: looking down and walking backwards showed a few huge blocks; "can we
shrink the voxel size for the player's arms?"

- **Your own limbs are drawn on the 1 cm lattice.** That's your arms, legs and feet, as a
  renderer-only entity (`fp-body`, `beaverFirstPersonAsset`, `cellTier: 'fine'`). It replaces your
  beaver for your own camera. Other players still see your normal beaver.
- **The torso is left out in first person.** At 5–10 cm it filled the lower view a hand's width from
  the camera.
- **No more trailing:** voxel frames reach the screen a frame or two after their time. Your limbs
  are now sampled that much later (a measured, smoothed lead, up to 250 ms), so they keep up when
  you walk. Before, the body ended up in front of you when walking backwards.
- **Assets can choose their lattice** (`VoxelAsset.cellTier`). Your limbs use one sample per 1 cm
  cell.
- **Cost (SwiftShader container, slow CPU):** the voxel frame median goes from 24 ms to 39–45 ms in
  first person. The 1 cm lane becomes the slowest of the parallel lanes. Unmeasured on phones.

## Online co-op diagnosis: relays fine, direct connections fail (2026-11-21, owner report)

Owner: "It never showed up" (a hosted game, on the same network). ADR 0012 has the full write-up.

- **Measured against the real public relays:** they work. The direct WebRTC connection is what
  fails when local addresses can't be resolved and the router can't loop traffic back. That fits
  two devices on one Wi-Fi.
- **Changes:**
    - ten relays together, all on port 443;
    - a connection-status line in the online panel;
    - optional TURN support, read from repository secrets at build time.
- **Needs the owner:** an account with a TURN provider, and its credentials as secrets.

## Your own body in first person (2026-11-21, owner request)

Owner: "why can't I see my hands/arms/body". Your own beaver wasn't drawn when playing alone. In
co-op it was drawn for the others to see, but its short arms hang 38 cm below the eye, so they were
never in view.

- **Your beaver is drawn in solo too.** Each device draws its own player's beaver without the head,
  through a new `BEAVER_FIRST_PERSON` animation channel set by the renderer. The camera sits inside
  the head. Other players, and split screen, see the whole beaver.
- **Hands in view:** for your own camera only, the shoulders move forward and the torso back. Both
  arms rest in a ready pose with the paws at the bottom corners of the view.
- **Arms reach when holding:** a new `BEAVER_ARM_RAISE` channel lifts both arms toward what you hold
  and follows your look. Other players see it too.
- **Engine:** assets can leave a part out of a frame (`VoxelAsset.partHidden`), and rig joints can
  be translated as well as rotated (`Rig.setShift`). Cubes still never rotate.
- **Tests:** new unit tests check that the head is hidden only for your own camera, and that both
  paws land inside the default view and higher while holding. The co-op test now expects a body in
  solo play.
- **Open:** the arms follow the voxel frames (20–30 Hz), so they lag a little behind fast turns.

## Online co-op on itch.io (2026-11-21, owner request)

Owner: "I should be able to do multiplayer from itch.io". ADR 0012 has the design.

- **Peer to peer:** outside claude.ai, "Play online" now connects the players' browsers directly
  over WebRTC. Public Nostr relays carry only the handshake, through Trystero 0.26.0. There is no
  server or account of ours. Hosting, the games list, joining, slots and snapshots are the same as
  over the claude.ai room.
- The lobby connects when the panel is first opened. The code loads only then (27 KB gzipped).
- **Tests:** the online browser test now also runs over WebRTC between two pages, through a small
  local Nostr relay (`tests/e2e/nostr-relay.ts`).
- **Open:**
    - no TURN server, so players on very strict networks can't connect;
    - not yet tried against the real public relays, which this container can't reach;
    - latency on real networks is unmeasured.

## Per-item voxel sizes, and water in the bucket (2026-11-21, owner request)

Owner: "I can't tell the bucket has anything in it. What if we adjust the resolution of the voxel
grid per item, so big things have big blocks and small things have small blocks, all the way down
to 1x1x1." ADR 0011 has the design.

- **The bucket held no water.** It had a water level but no water part. It now has one, in a new
  bright blue (`bucket-water`).
- **Three lattices, one origin:** fine 1 cm (the bucket, the ragdoll's head and limbs), base 5 cm
  (the player's setting: the world, beavers, timber and props) and coarse 10 cm (the ute). The tier
  is picked from each asset's size. One voxel worker runs per lattice, and every lane's meshes for
  a voxel frame are applied together. `?tiers=off` puts everything back on one grid.
- **The bucket at 1 cm:** a 1.5 cm wall, a thin handle and a visible water surface. Before, it had
  an 8 cm wall around a hole one or two cells wide.
- **Cost (Timber Yard, SwiftShader):** median voxel frame 26 ms with tiers on against 37 ms off.
  The lanes work in parallel. Every vertex is still on its lattice (`verifyGrid`: 0 misaligned).
- **Tests:** 218 unit tests (new: tier rules, lattice sizes, a lane drawing only its own objects,
  out-of-reach objects cleared) and the browser suite.
- **Open:** objects on different lattices intersect instead of resolving by priority; the grid-line
  overlay shows the base lattice only; the tier thresholds may want tuning once more assets exist.

## Wind, leaves, particles, the tutorial and the level designer (2026-11-20, owner request)

Owner request: particle effects, falling leaves and wind; a level designer; a tutorial level; a
5 cm default grid. Join codes / choosing to host and a settings menu were deferred by the owner.

- **Wind:** one analytic field per level (`src/fx/wind.ts`: direction, base speed, gusts). It
  drives a windsock in the Timber Yard, water ripples, leaf drift and a drag force on light bodies
  that are moving or held (resting bodies are left asleep).
- **Particles as voxel cells:** falling leaves from the oak crowns (60 leaf slots within 30 m of
  the camera, resting on the ground or floating on the creek), dust when props land hard, wood
  chips for timber, and splashes when anything (a player too) drops into the water. Every device
  computes them from data it already has, so nothing extra goes over the network, and they stay on
  the world grid. Cost: about +1.3 ms per voxel frame at 10 cm and +2 ms at 5 cm (SwiftShader).
  The **Particles** toggle is in the debug panel's Physics section.
- **Tutorial (the new first level):** 8 steps (look, walk to a sign, jump a log, grab a crate,
  carry it onto a pad, throw a ball into a bin, bridge a ditch with a plank, deliver the bucket),
  each shown as "Step k/8" in the HUD. A first visit starts here; the **Levels** menu lists the
  Timber Yard and the River Lab.
- **Level designer:** **Levels → Level designer**. Tools: box, post, pine, oak, rock, ditch (two
  clicks), hill, plank / beam / log / crate / ball / bucket, start and goal. Click to place or
  select; arrows move (Shift: 1 m), Q / E turn, Delete removes; the panel edits numbers and
  materials. Changes show as outlines at once; **Build** rebuilds the voxel world (a reload, the
  camera is kept), **Play** playtests in first person. The draft is saved in the browser;
  **Copy JSON** / **Import** move levels in and out — paste one to Claude to add it to the game.
  Levels are the same JSON format as the tutorial (`src/levels/data.ts`), validated and clamped
  on load.
- **5 cm grid:** 5 cm was already the default. A size chosen with the slider is saved and wins over
  the default; the new **Reset to 5 cm** button (shown when another size is active) clears it, and
  choosing 5 cm now stores "no choice", so a later default change is not hidden.
- **Tests:** 212 unit tests pass (new: wind, particles, tutorial steps, designer data round trip,
  clamping and a custom level that builds and plays). New browser tests: the tutorial on a first
  visit, and the designer placing a box with a click.
- **Not done yet:** undo in the designer, pieces other than boxes from the toolbar (cylinders and
  ellipsoids work in JSON), sharing designed levels online (a guest needs the host's level data),
  more than 6 planks / 2 beams / 3 logs per level (fixed entity pools).

## Online co-op on phones (2026-11-20, owner request: "let two people join this on their phones")

ADR 0010. One device hosts the game; phones (or any device) join over the claude.ai artifact's
`room` capability — no server of ours.

- **How to play:** share the artifact with the players (Share menu; they must be signed in — a
  public link cannot join rooms). One person opens it and taps **Play online → Host a game**; the
  others open the same link, tap **Play online** and join the listed game (4-letter code). Up to 4
  players, including local split-screen players on the host.
- **Phones:** touch controls appear in first person — left thumb moves (push to the edge to run),
  right thumb looks, buttons Jump / Grab (Release) / Throw / Drop. Landscape works best.
- **Netcode:** host-authoritative; guests send input as presence (with press counters), the host
  sends 20 Hz pose snapshots (~600 bytes for the yard with two players), guests interpolate 150 ms
  behind and rebuild voxels locally. Prompts, objective and messages come from the host.
- **Also:** the sim now has 4 player slots (local and online share them).
- **Tests:** 92 unit tests × 2 = 184 pass (new: codec precision, wrap, garbage; sessions over an
  in-memory hub: lobby listing, slot assignment, guest movement on the host, snapshot fidelity,
  render delay, allowed actions, full games, leaving). New browser test: two pages linked by
  BroadcastChannel — host, join, guest drives player 2, guest renders 17 objects on the grid, leave
  frees the slot (passed 3 runs in a row). Touch checked in a Pixel 7 landscape emulation (jump
  button jumps 0.86 m; drag turns the view; layout clear of the dock).
- **Not tested:** the real claude.ai room (only reachable in the viewer) and real phones/networks.
  Latency feel, presence rate limits in practice and phone thermals are open. No prediction for a
  guest's own movement yet (it lags by a round trip + 150 ms). The host must stay in front.

## Local co-op: two players, split screen, gamepads (2026-11-20, owner request)

The owner will test two-player on a Steam Deck with two gamepads. ADR 0009 has the design.

- **Join:** press **A** on a pad: the first pad drives player 1 (keyboard and mouse still work),
  the next pad joins as **player 2** and the screen splits top (P1) / bottom (P2). Unplugging player
  2's pad returns to one player. Debug panel → Physics → Players also switches 1 / 2 (player 2 then
  stands still without a pad).
- **Pad controls:** left stick move · right stick look · A jump · LT or L3 sprint · RT grab /
  release · RB throw · B drop · X ragdoll · Y plank (player 1) · D-pad up/down reach.
- **Two beavers, one world:** both players are voxel beavers the other sees (walk cycle, carry
  pose), they bump into each other, and they can hold the same object: forces add, each bounded.
  Force cap per beaver raised 450 → **650 N**: beams and planks are easy alone, and the **113 kg log
  now needs two beavers** (unit tested: one cannot lift it, two can, each under the cap).
- Each player has their own creek recovery; the level objective is shared.
- **Split screen** works around the engine's CameraFrame ignoring viewport rects (half-height
  targets, compose viewports); water uses its sky reflection while split (planar reflection follows
  one camera only). Single player is unchanged.
- Also fixed: the level no longer starts with the comfort-test plank in your hands (it stays on by
  default in the River Lab only); level start no longer requests pointer lock without a click.
- **Tests:** 87 unit tests × 2 = 174 pass (new: deadzone, stick move and look rate, one command per
  press, Y only for player 1; two players move independently, bodies only in two-player mode, the
  two-beaver log lift, per-player creek recovery, two-player determinism). New browser test: both
  split halves render lit and different, player 2 walks on their own commands, back to one player.
- **Not measured:** the Steam Deck (no device here). In this sandbox's software GL, split screen at
  10 cm drew ~2,150 draw calls a frame (two views). Suggested start on the Deck: Low preset, 7.5–10
  cm voxels (slider), then try High / 5 cm. Gamepads were tested with simulated pads only; please
  check the button layout on the Deck (Steam Input may remap).

## Level 1 — the Timber Yard (2026-11-20, owner request after gate 2)

Owner, after trying the gate 2 build ("this works"): set up the very first level, in first person.
The design doc's first area is the **timber yard and shallow creek** (§3.1). Built ahead of the
roadmap's Epic 3 (co-op networking) at the owner's request; uses only the systems that exist
(physics, carry, throw, ragdoll). Sawmill, fastening, driving and co-op are later epics.

- **Default level** (`?level=lab` for the River Lab test scene). Starts in first person at sunrise
  in the yard, facing the creek; the objective is in the HUD.
- **Layout:** gravel yard with a timber shed, a six-plank stack, two 3.2 m beams (36 kg, liftable
  alone), a three-log pile (113 kg each, drag only), a crate, a saw bench (decoration until Epic 6),
  the parked ute, a co-worker beaver, and the bucket on a stump. North: a steep-walled creek (water
  0.85 m below the banks, 0.6 m deep) across the whole valley; the old footbridge has collapsed,
  leaving stone abutments **2.6 m** apart. Beyond: a forest road climbing to the terraced ridge,
  where the flower stands on the summit as the journey's landmark.
- **Objective:** get the bucket to the flag on the far bank (it must rest there 0.5 s). The intended
  solution is to carry the beams (and planks) across the gap and walk over. Throwing the bucket
  across (it weighs 1.5 kg) is likely possible and not forbidden (freeform, §2.1), but untested.
- **Recovery (§2.10):** falling into the creek puts you back on the last safe ground after 0.75 s;
  a bucket lost in the creek returns to its stump after 1.5 s. Both show a message.
- **Code:** levels are now data (`src/levels/level.ts`: terrain, layout, pieces, water, sun, spawn,
  actors, prop placements, rules); the River Lab is one (identical static output: 1,140,431 cells
  and 233,066 quads at 10 cm, as before). Shared terrain rasterizer, pines and rocks in
  `levels/common.ts`. Static scenery pieces are both voxels and colliders. The character's autostep
  now includes dynamic bodies, so laid beams can be walked onto.
- **Tests:** 79 unit tests × 2 cell sizes = 158 pass (8 new for the level: build, gap geometry,
  props at rest, creek fall recovery, walking across two laid beams, lifting a beam, objective once,
  bucket recovery). Browser tests: existing ones pinned to `?level=lab`; new yard test (first
  person, objective, 15 objects, grid invariant, delivery completes the objective with the toast).
- **Cost (sandbox CPU, Node):** static build at 5 cm 5.1 s, 6.8 M cells, **1.79 M triangles**
  (River Lab 1.49 M) after trimming trees and terracing the ridge and the upper forest (from 2.8 M).
  At 10 cm: 0.57 M triangles, 348 drawables in the browser.
- **Please try on the phone:** frame time at 5 cm in the yard (it has ~20 % more triangles than the
  River Lab that ran at 60 fps).

Known for this level: the sign board's lettering is abstract dots; the near abutment can look
very bright in the low sun; resting props still sit up to one cell into the voxel ground (gate 2
known issue 1); no fastening, so a beam bridge is only held by friction.

## Gate 2 — Epic 2 "Physical sandbox (offline)" (2026-11-20)

**Status: built and verified to the extent this environment allows. Waiting on the owner to try it
(an explicit gate). Epic 3 has not been started.** ADR 0008 records the design.

### Environment for every number below

|          |                                                                                         |
| -------- | --------------------------------------------------------------------------------------- |
| CPU      | Intel Xeon @ 2.10 GHz, 4 vCPU (cloud sandbox; a different, similar machine from gate 1) |
| GPU      | **none**: headless Chrome, SwiftShader software WebGL2                                  |
| Node     | 22.23.5                                                                                 |
| Packages | as gate 1, plus **@dimforge/rapier3d-compat 0.21.0** (exact pin)                        |

As at gate 1, there is no GPU here, so **frame times on a real desktop and on the owner's phone
were not measured**: the browser renders at ~0.5 fps in software, and every browser frame time and
dropped-tick count below is a sandbox artefact. CPU-side physics and voxel costs are real.

### Task 1 — mobile portrait layout (done first, own commit)

The voxel-size box and debug chip now sit in a bottom dock whose measured height bounds the debug
panel, so nothing can overlap. On screens ≤ 700 px wide the panel is a bottom sheet below the HUD
with the stats first, the HUD help is shortened, and touch targets are ≥ 40 px (also on any
coarse-pointer device). Wide screens narrow the HUD when the panel is open. H and F3 / the chip
still work. New e2e test checks the rectangles at 390 × 844, 768 × 1408, 1280 × 720 and 844 × 390
with the panel open and closed, touch-target heights, the chip toggle and H; it fails on the old
layout ("HUD overlaps debug panel" at 390 × 844). Screenshots: `docs/screenshots/layout/`.

### What was built (Epic 2)

- **Rapier** in the engine-free sim layer (`src/sim/physics/`, `src/sim/lab-physics.ts`), stepped
  by the existing fixed 60 Hz tick; poses flow out as snapshots → main thread samples at the voxel
  time → voxel worker rasterizes (unchanged). Nothing flows back from render or voxels.
- **Static collision from the analytic level, never voxels:** a 251 × 251 heightfield from
  `terrainHeight` (within 1.1 cm of the analytic surface), tree trunks and needle cones and rock
  hulls from the same `labLayout()` the voxel build uses, invisible walls at the Epic 1 walker limits.
- **Character:** Rapier kinematic character controller replaces the terrain walker: walk 2.2 m/s,
  run 4.2, jump, 0.32 m step-up (smoothed for the camera only), ground snap, 50° climb limit,
  bounded pushing of props (no contact forces on props from the capsule).
- **Grab / release / throw:** left click or E grabs what the crosshair points at (2.6 m reach) and
  releases it; right click throws; wheel adjusts reach; Q drops; G puts a plank in your hands. A
  context prompt under the crosshair says what a click will do. Force law: spring-damper at the grab
  anchor, gravity support first, capped at **450 N**; snag release after 0.75 s beyond 1.25 m (or at
  once beyond 2.2 m); held objects ignore the player (no stand-on-what-you-hold feedback).
- **Bodies:** plank 24 kg, log 113 kg (too heavy to lift alone; drag it), crate 25 kg, bouncy ball,
  ~1.5 kg bucket proxy, carry plank, **ragdoll dummy** (7 boxes, ball joints; T launches it), up to
  **25 stress bodies** kept moving by a deterministic fountain, and kinematic colliders following
  the scripted beaver and ute (they push props).
- **Safety bounds** after every step: |v| ≤ 30 m/s, |ω| ≤ 30 rad/s, recovery of lost bodies,
  and a 0.5 s post-release speed bound — all counted in the debug panel.
- **Scripted props stay available:** debug panel → Physics → Props, or `?props=scripted`.
- **Commands** are plain sequenced data with edge-triggered requests, sanitized before use.
- **Drop test:** `LabSim.dropTest()` / panel button; `scripts/drop-test.ts` writes the voxel
  captures (`docs/screenshots/epic2/drop-test-5cm.png`, `-10cm.png` and `.json`).
- Debug: physics collider wireframes, physics stats; `scripts/soak-physics.ts`,
  `scripts/capture-epic2.mjs`; `bench-voxels` runs with physics or scripted props.
- Publish build loads Rapier from jsDelivr through the import map (85 KB own bundle). **Not
  verified from here:** this sandbox cannot reach jsDelivr. `npm run build` bundles Rapier:
  main chunk 5.9 MB raw / 2.1 MB gzip (was 1.5 / 0.4 MB).

### Test results (actual)

- Unit (Vitest): **142 / 142 runs pass** (71 tests × 5 cm and 10 cm). New: command sanitizing and
  JSON round trip; grab force never above the cap for any distance, mass or velocity, gravity hold,
  log too heavy, NaN rejected, throw and reach bounds, view convention; heightfield vs analytic
  terrain (< 2 cm); props come to rest without sinking; character stands, walks, is stopped by walls,
  jumps and lands; climbs three 0.3 m terraces; grab-carry-throw for 10 s of turning with max held
  speed < 15 m/s and zero clamps; a violent flick drops the plank instead of flinging it; snag
  release on the log; Q drops; release speed bound; G carry; ragdoll settles with joints intact;
  identical states for identical commands (grabs, throws, ragdoll, drop test, stress); 25 bodies keep
  moving; scripted mode unchanged; drop test deterministic with stepped, never-vanishing voxel
  silhouettes and identical cells at rest.
- Browser (Playwright, production build): **9 / 9 pass** (2 new: UI overlap; physics sandbox
  grab → lift → throw → ragdoll → scripted switch with no console errors and 0 rejected parts).
  The boot test's dynamic/static overlap bound was raised from 50 to 400 cells: resting physics props
  share one layer of cells with the voxel ground (measured 123 at 5 cm; see known issue 1).
- `npm run typecheck`, `npm run lint`, `npm run build`: pass.

### Measurements (actual)

**10-minute playground soak** (`node scripts/soak-physics.ts 10`; scripted player walks, sprints,
jumps, carries the plank while turning and looking up and down, throws it, walks to and grabs the
nearest prop, drops it, launches the ragdoll every 40 s, runs the drop test; 25 stress bodies for the
second 5 minutes):

|                                       | ticks  | avg  | p50  | p95  | p99  | max (ms per 60 Hz tick) |
| ------------------------------------- | ------ | ---- | ---- | ---- | ---- | ----------------------- |
| base scene + player + ragdoll         | 18,000 | 0.51 | 0.47 | 0.83 | 1.16 | 4.77                    |
| + 25 moving stress bodies (36 active) | 18,000 | 1.56 | 1.60 | 2.53 | 3.06 | 12.86                   |

- Ticks over the 16.7 ms budget: **0** (so no dropped ticks from physics on this CPU).
- Held props: max speed 10.2 m/s, force never above the 450 N cap. Max sampled speed of any
  dynamic body 10.2 m/s. Non-finite poses 0, bodies recovered 0.
- 30 carries, 30 throws, 23 / 30 bot grabs succeeded (the 7 misses were not investigated; the bot
  aims at the prop's centre from wherever it stopped walking), 15 ragdolls.
- **Grab breaks 21**: 20 carries ended in a snag release and 1 log lift attempt broke. At every
  carry break the plank was touching static geometry (tree trunks or cones, rocks, the invisible
  boundary walls the bot wanders into, the ground). Nothing exploded; 3 post-release speed bounds
  and 1 linear clamp fired in 10 minutes; angular clamps 86 (ragdoll arms on their joints).
- Before two fixes in this gate, the soak found: (1) the grab sagged and saturated when turning,
  because the damper treated the swinging hold point as error (now uses its real velocity, with
  gravity support kept first under the cap); (2) a plank snag-released out of a tree trunk at
  21 m/s (now bounded for 0.5 s after any release).

**Main thread in the browser** (5 cm, low preset, software GL — physics numbers real, frame times
not): physics tick avg 0.83 / p95 2.9 ms with 1 moving body, 0.87 / 2.3 ms with 25; upload 4.0 ms
(1 body) and 10.9 ms (25 bodies) per applied voxel frame; frame time ~2,000 ms (software GL).

**Voxel worker cost with physics props** (Node, 5 cm, 20 Hz, `bench-voxels`; ms p50 / p95 per
voxel frame; same run, same machine for both):

| props             | moving extra bodies | raster | mesh  | total       |
| ----------------- | ------------------- | ------ | ----- | ----------- |
| scripted (Epic 1) | 0                   | 25.1   | 27.0  | 59.2 / 83.6 |
| physics           | 0                   | 24.7   | 26.7  | 61.0 / 88.6 |
| scripted          | 25                  | 46.5   | 50.5  | 138 / 173   |
| physics           | 25                  | 44.6   | 120.0 | 198 / 312   |

Physics bodies tumble on and rest against the terrain; each overlap with ground voxels re-meshes a
whole 6.4 m static region (the Epic 1 compositor rule), so meshing with 25 physics bodies costs
2.4× the scripted case. In the browser the worker took 147 ms (1 body) and 190 ms (25) per voxel
frame on this CPU; the voxel rate drops instead of the frame rate (0 skipped frames, lag 1–2).

**Phone and desktop GPU: not measured** (no access here). Please read the debug panel on the phone
with Extra moving objects at 1 and at 25: "frame ms", "physics tick ms", "worker total" and
"dropped ticks".

### Known issues and limitations

1. **Resting props look up to one cell sunk** into the ground: physics uses the analytic terrain,
   and the voxel ground surface lies 0–1 cell above it (0–5 cm at 5 cm). Lifting the collision
   surface would tie physics to the render setting; options for the owner are a fixed 2.5 cm lift
   or snapping the voxel ground down.
2. **25 physics bodies make voxel meshing expensive** (above). Options: per-cell static patching
   instead of whole-region re-meshing, smaller static regions near the play area, or treating
   one-cell ground contact as "dynamic hides nothing".
3. **Carrying a 2.4 m plank snags often** on trees and walls, because the held plank's orientation
   is free (damped). Orientation control (R / right mouse in the brief) is not built yet.
4. Ragdoll joints have no angle limits (arms can spin through); it never recovers on its own — it is
   an experiment, not the beaver.
5. The terraced ridge is only climbable for the first three benches (treads narrower than a
   heightfield cell); it is outside the play area.
6. Determinism is same-build, same-platform only (Rapier's enhanced-determinism build not used).
7. Rapier's heightfield misses rays exactly on cell boundaries; avoided by a non-round cell size.
8. No touch controls (out of scope unless requested). Firefox / Safari not tested.
9. Bundled build grew by ~1.7 MB gzip (Rapier's inlined WASM); the publish build loads it from the CDN.

### Owner gate — please try

1. In first person (`V`), click the plank, look up, walk and turn: does carrying feel responsive
   and bounded? Throw it (right click). Try the 113 kg log (you can drag it, not lift it).
2. Launch the ragdoll (`T`): funny enough to keep developing, or tone it down?
3. Is the one-cell sink of resting props (known issue 1) acceptable?
4. Phone numbers with 1 and 25 moving bodies (debug panel).
5. Should a held plank keep its orientation relative to the view (fewer snags) or stay floppy?

### Evidence

`docs/screenshots/epic2/`: 01 sandbox props, 02 first-person aim, 03 carrying the plank,
04 ragdoll launch, 05 ragdoll landed, 06 collider wireframes over the voxels, 07 25 moving bodies,
`drop-test-5cm.png` / `drop-test-10cm.png` (+ JSON: poses, angles, cell counts, hashes; both runs
identical). Regenerate with `node scripts/capture-epic2.mjs` and `node scripts/drop-test.ts`.

## Owner approval of Epic 1 (2026-11-20)

Aaron approved the River Lab ("Game looks fantastic", "I think this is going to work") after testing
the 5 cm build on an Android phone: Adreno 840, canvas 768 × 1408, High preset, 59.8 fps, frame
avg 16.7 ms / p95 19.1 ms / max 31.3 ms, 2,252 draw calls, 350 drawables, 1.5 M triangles, voxel
worker 28 ms per frame (raster 11.9, resolve 3.3, mesh 12.8), main-thread upload 1.1 ms, lag 1
frame, 0 skipped voxel frames. Known: in portrait the voxel-size box overlaps the debug panel.
Next: see `START_HERE.md` (mobile layout fix, then Epic 2).

## Gate 1b — voxel size as a quality setting, 5 cm default, worker reconstruction (2026-11-19)

Owner feedback on gate 1: frame rate fine on their phone, look approved. Requests: 5 cm voxels, then
a voxel-size slider (asked 0.5–10 cm). See ADR 0007.

- **Done:** cell size is a per-player setting, 5–10 cm in 0.5 cm steps, default 5 cm, bottom-left
  slider (saves, reloads), `#cell75`-style hash. Everything derives from it; physical render-unit
  sizes are constant so draw calls stay ~350 drawables.
- **Not done, by measurement:** below 5 cm. Static world cost on this CPU: 10 cm 1.4 s / 25 MB /
  0.47 M tris; 5 cm 7.3 s / 99 MB / 1.49 M; 4 cm 13 s / 157 MB / 2.2 M; 2.5 cm 47 s / 418 MB /
  5.2 M. 0.5 cm is ~8,000× the 10 cm cell count.
- **Phase C adopted** (needed for 5 cm): voxel world in a Web Worker. Browser measurements
  (software GL, 2 vCPU, low preset): 5 cm — worker build 3.4 s + static mesh 2.4 s, upload 0.2 s,
  1.52 M triangles, 352 drawables, voxel frame 76 ms median in the worker, **main-thread upload 3.6 ms
  median / 18.5 ms max**, heap 138 MB. 10 cm — 1.0 + 0.5 s, 0.47 M triangles, worker 16 ms,
  upload 1.4 ms median.
- At 5 cm on slower devices, moving props update at a lower effective voxel rate (~13 Hz here)
  rather than stalling frames; the debug panel shows lag and skipped voxel frames.
- Rasterizer interior fast path and empty-space skipping in meshing: identical output, 72 → 50 ms
  per voxel frame at 5 cm in Node.
- Beaver hat dome trimmed so the standing beaver is exactly 1.40 m at every cell size.
- Tests: 47 unit tests × 2 cell sizes = 94 pass; 7 browser tests pass (2 new: `#cell100` loads the
  10 cm world; default 5 cm with slider range 5–10).
- Screenshots in `docs/screenshots` are now at 5 cm; `docs/screenshots/10cm/` keeps three 10 cm
  references. The video `docs/media/river-lab.mp4` is still the 10 cm capture.

## Gate 1 — Epic 0 + Epic 1 "River Lab" (2026-11-19)

**Status: built and verified to the extent this environment allows. Waiting on the owner's visual
approval (an explicit gate). No later epic has been started.**

### Environment used for every number below

|                     |                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| CPU                 | Intel Xeon @ 2.10 GHz, 2 vCPU (cloud sandbox)                                                                              |
| GPU                 | **none** — Chrome 1xx headless, ANGLE → Mesa llvmpipe (software WebGL2)                                                    |
| Node                | 22.23.5                                                                                                                    |
| Browser tests       | system Google Chrome via Playwright 1.65.1, `--use-angle=swiftshader`                                                      |
| Viewport            | 1280 × 720 (screenshots), 960 × 540 (video)                                                                                |
| Packages (lockfile) | playcanvas 2.24.2, vite 8.3.8, typescript 6.0.3, vitest 5.1.1, @playwright/test 1.65.1                                     |
| Scaffold            | `npm create playcanvas@latest uncivil-engineers -- -f engine` (create-playcanvas 0.17.0, minimal engine starter, defaults) |

Because there is no GPU, **no frame-rate target in §7.4 has been measured**. Browser frame times
below are software-rendering times and must not be read as performance results. CPU-side voxel
reconstruction was measured headlessly in Node, which is representative of the main-thread cost on
a comparable desktop core (a fast desktop core will typically be quicker than this 2.1 GHz vCPU).

### Commands

```sh
npm install && npm run check        # typecheck, lint, 47 unit tests, production build
npm run test:e2e                    # 5 browser tests (builds must exist: npm run build)
node --expose-gc scripts/bench-voxels.ts 10 20
node scripts/bench-static.ts
npm run start & node scripts/capture.mjs --video
```

### What was built

- Epic 0: official scaffold kept (strict TS, ESLint, Prettier, Vite), Vitest + Playwright added,
  `npm run test`, `test:e2e`, `check`, lockfile committed, design doc in `docs/GAME_DESIGN.md`, ADRs.
- Grid contract (§5.1): 10 cm cells, fixed origin, `floor` indexing, half-open cells, signed integer
  indices, sparse 16³ chunks with small-integer keys.
- CPU reference rasterizer (§5.3): conservative world AABB → candidate cells → inverse-pose centre /
  sub-sample tests → per-object occupancy → deterministic composite → dirty chunks → greedy exposed-face
  meshes → one atomic commit before any pass renders. Four sampling policies switchable live.
- Assets from analytic volumes (§5.2): beaver on a joint rig with walk cycle and paddle tail (14 cells
  tall), ute with steered/spinning/suspended wheels, 2.4 × 0.2 × 0.1 m plank, 0.4 m × 2 m log, ~10 L
  bucket with handle, test cube and sphere, pines, rocks, reeds, flowers, terrain with river and a
  terraced ridge.
- Scripted motion only (no physics, §7.2 step 3): beaver walks a loop carrying the bucket and pauses to
  look around; ute laps an oval track; plank hovers, translates and tumbles; log rolls without slip;
  cube slides diagonally while turning; sphere bounces and rolls; 0/1/10/25 extra stress objects.
- Lighting and water (§5.6–5.8): dynamic sky at golden hour driving the sun colour and IBL, PCF5
  cascaded shadows, ACES tone mapping with a light warm grade, fog matched to the horizon, bloom,
  vignette, per-vertex voxel AO (ambient only); engine `Water` script for planar reflection with
  oblique clipping, refraction, depth tint, shoreline foam and caustics on the riverbed.
- Cameras: orbit (engine CameraControls) and a first-person walker with interpolated position,
  display-rate look, FOV and sensitivity; optional carried plank voxelized in world space.
- Debug panel (§7.3) and a test API used by Playwright and the capture script.

### Test results (actual)

- Unit (Vitest): **47 / 47 pass**. Covers negative coordinates and chunk seams, translation 0 → 0.1 m
  (exactly one transition), rotations 0°/15°/45°/89°/90° under all four policies, same-pose hash
  identity with zero dirty cells, overlap winners and restore-on-leave, static never erased, full-turn
  thin geometry for plank/log/wheel (never disappears under any policy), mesher vs brute force across
  seams (static and dynamic rules), no coplanar duplicates, greedy == per-face coverage, 100% vertices
  on grid planes, CCW winding, axis-aligned normals, AO, clock and snapshot interpolation, sim
  determinism, beaver height = 14 cells, both eyes visible (1–3 exposed cells each) plus teeth, nose,
  hat, vest, tail at 72 headings × 4 phases, wheels on the ground and visibly spinning, 3,000-frame
  long run with periodic hash identity and no chunk growth.
- Browser (Playwright, production build): **5 / 5 pass** — boot with no console errors and a
  colour-sane non-blank frame; every uploaded vertex on the grid and every render unit at identity;
  deterministic reconstruction per time; reference mode, all voxel rates, all policies and 25 stress
  objects without errors or rejected parts; first-person carry.
- `npm run typecheck`, `npm run lint`, `npm run build`: pass.

Bugs found by these checks and fixed during the gate: a crash from re-assigning render mesh instances
(the engine destroys previously assigned instances), and voxels rendering white because instances
were created before their meshes had a vertex-colour stream. The second passed every functional test
and was caught only by looking at screenshots; a pixel colour check now guards it.

### Measurements (actual)

**Static scene** (Node, `scripts/bench-static.ts`; browser at load in brackets):
313,600 terrain columns, ~1.14 M static cells, 2,611 chunks, ~35 MB typed arrays; rasterize
0.9–1.0 s [0.68–0.87 s]; mesh 268 regions 1.16 s [1.12–1.33 s]; 232k quads / 464k triangles.
Optimisation history: 1.32 M → 632k triangles (merge-friendly colour patches) → 464k (implicit
bedrock + terraced ridge, ADR 0005).

**Voxel reconstruction CPU cost per voxel frame** (Node, 20 Hz, scripted scene, after the two
output-identical optimisations in ADR 0002/0004; ms p50 / p95):

| Policy                   | Extra objects | Frames | Raster     | Resolve   | Mesh        | **Total**       | Max  | Samples | Cells | Dyn chunks meshed |
| ------------------------ | ------------- | ------ | ---------- | --------- | ----------- | --------------- | ---- | ------- | ----- | ----------------- |
| center                   | 0             | 300    | 1.4 / 2.0  | 0.6 / 0.8 | 5.6 / 9.0   | **7.6 / 11.7**  | 22.8 | 7.5k    | 5,332 | 29.8              |
| **coverage50 (default)** | 0             | 300    | 4.0 / 6.0  | 0.6 / 0.9 | 5.8 / 10.4  | **10.5 / 16.1** | 27.7 | 89.5k   | 6,006 | 30.4              |
| coverage25               | 0             | 300    | 4.2 / 6.0  | 0.7 / 1.1 | 5.8 / 11.1  | **10.9 / 16.1** | 26.1 | 89.5k   | 6,975 | 31.4              |
| conservative             | 0             | 300    | 3.6 / 5.5  | 0.7 / 1.1 | 10.5 / 16.9 | **14.9 / 22.0** | 31.8 | 57.5k   | 8,794 | 32.6              |
| coverage50               | 10            | 300    | 5.4 / 7.3  | 1.4 / 1.8 | 10.5 / 15.5 | **17.3 / 22.4** | 29.8 | 110.8k  | 7,200 | 61.4              |
| coverage50               | 25            | 300    | 7.4 / 11.5 | 3.2 / 4.5 | 16.9 / 26.6 | **27.7 / 42.2** | 50.8 | 144.1k  | 9,107 | 100.4             |
| coverage50, 10 min       | 0             | 12,000 | 3.9 / 5.4  | 0.6 / 0.8 | 5.5 / 10.0  | **10.0 / 15.4** | 31.7 | 89.4k   | 6,003 | 31                |

Raw output: `node --expose-gc scripts/bench-voxels.ts 10 20` (also saved locally as
`artifacts/bench-voxels.txt`, not committed).

Before those two optimisations the default was p50 12.6 / p95 16.9 ms (231k samples per frame).
**The §7.4 first-pass budget of ~4 ms raster + mesh is not met:** the default is about 2.5× over it
on this CPU (p50 10.0 ms over 10 minutes). Raster is ~4 ms, meshing ~5.5 ms (≈30 dynamic 16³ chunks
re-meshed per frame); GPU upload adds ~3–5 ms in the browser. There were no periodic >50 ms stalls
in the base scene (max 31.7 ms over 12,000 frames); 25 extra objects reach 50.8 ms.

**Browser** (software WebGL; for scale only): 409 drawables, ~3,700 draw calls per frame across the
main pass, depth pass, 3 shadow cascades, reflection and refraction; ~0.8 fps at 1280 × 720.
Heap ~90–120 MB.

**Memory / stability:** 10 simulated minutes at 20 Hz (12,000 voxel frames) in Node: heap flat at
7.3–7.7 MB after GC, chunk count +8 over the run (first visits of a quasi-periodic path), zero
rejected parts. The 3,000-frame unit test shows no chunk growth for strictly periodic motion.

### Known issues and limitations

1. **CPU budget over target** (above). Options for the owner: accept 12 Hz for distant/cheap objects,
   move rasterization + meshing to a worker with transferable buffers (Phase C, §5.5), reduce
   per-chunk fill cost (incremental padded-occupancy updates), or per-object meshes for isolated
   objects. Not done yet because Phase C should follow this measured gate.
2. **No GPU measurement.** 60 FPS at 1080p is unverified. Draw calls (~3,700) are the likely first
   GPU-side cost on real hardware; mitigations: larger static render regions, fewer cascades, culling
   the far ridge from the refraction pass, static batching.
3. Static shadows are re-rendered every frame (all cascades); a cached static cascade would help.
4. Fog colour is sampled from the sky once per sun change and only towards −Z.
5. Bucket water surface (smooth exception) is not implemented yet (Epic 7); the bucket is empty.
6. The first-person walker follows the analytic terrain height, not physics, and has no collisions
   with trees, props or the ute (Epic 2).
7. Firefox and other browsers not tested yet (Chromium only).
8. Water ripple normal map and caustics are procedural and tileable; they are a first pass.
9. The beaver face reads at 14 cells but needs owner judgement: under the hard-hat brim's shadow the
   eye row can read like goggles, and the teeth row is wide at some offsets.

### Owner gate — please judge

1. Beaver cuteness and legibility at 14 cells (screenshots 02, 03; video).
2. Size of the 10 cm voxels relative to characters, props and the world.
3. Diagonal turning: the stepped plank, log and ute (screenshots 05/06 voxel vs reference at the same
   instant; 10 rotation strip). Is the cell flicker acceptable at 20 Hz? Try 12/30/60 Hz live.
4. First-person comfort with a carried plank (screenshot 09; try `V` then `G` live).
5. Water: reflection of reconstructed objects, shallow colour, foam (screenshots 01, 08).
6. Golden-hour palette and atmosphere.
7. Sampling default (coverage50) vs alternatives.
8. Whether to proceed with the CPU optimisation path or Phase C workers before Epic 2.

### Evidence

`docs/screenshots/` (01–11) and `docs/media/river-lab.mp4` (deterministic, 24 fps, 20 Hz voxel
clock, continuously moving camera: the camera glides every frame while cells update only on voxel
frames). `docs/screenshots/stats-at-capture.json` holds the live stats at the end of capture.
