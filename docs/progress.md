# Progress log

## Route signs and distant landmarks in the Valley (2026-11-22, Epic 9, #16)

### Route signs

Each area from the Forest Road on starts with a route sign beside the road.

- **What it shows:** the area's number in big pixel digits and an arrow for the way on, on a band
  of the area's colour.
    - The arrow bears left or right where the road bends ahead.
    - The sign faces players coming up the road.
    - They replace the plain coloured signposts.
- **Readable at both voxel sizes:** one glyph pixel is 10 cm. The board stands square to the world
  grid, snapped to 10 cm lines, so every pixel is whole cells at 5 cm and at 10 cm.
- **The code:** `src/levels/route-signs.ts`. Other levels can use it.

### Distant landmarks

Each area now has a silhouette you can head for.

- **New:**
    - **Forest Road:** a fire lookout on the ridge. It is a timber cabin with a hi-vis band, on 11 m
      braced legs, and it stands over the pines. You can see it from the Timber Yard.
    - **Mountain Approach:** an 18 m radio mast, banded orange and white, with a dish and a hut.
- **Already there:** the gorge's waterfall, the works' chimney and crane, and the summit flower.
- **Far away:** every part is at least 42 cm thick, so it still shows in the coarse 40 cm far lattice.
- **Trees** are kept off both landmarks.

### Tests

- `tests/unit/route-signs.test.ts`:
    - voxelizes a sign facing each of the four ways, at 5 and 10 cm, and reads the digit and arrow
      back cell by cell;
    - checks the board's height and that the posts reach the ground;
    - for each of the Valley's five signs, checks it reads its area's number, its arrow points
      where the road bends, and it faces down the route and towards the road.
- `tests/unit/landmarks.test.ts`:
    - voxelizes every part of the lookout and the mast at the far lattice's 40 cm, and each writes
      cells;
    - checks no tree stands within 4.5 m of either;
    - checks the sight line from the bucket stump to the lookout cabin clears the ground and every
      tree's crown.
- Unit tests: 342 pass.
- The Valley's streaming tests pass with the new pieces, including "a tile builds the same whether
  its neighbours are built or not".

## The beavers are back (2026-11-22, Epic 9, #90)

The tall people that stood in for the beavers are gone. Players, online avatars and the River
Lab's walking co-worker are beaver engineers again.

### What changed

- **The switch:** `PLAYER_BODY` in `src/assets/player-body.ts` is `'beaver'` again. The person body
  is still in the code and still passes every test, should you want it back.
- **Things sit in the beaver's paws, out in front, where a person carried them.** When the people
  came in they learned to carry things at arm's length, with both hands on the grip. The beaver now
  does the same.
    - Its arms are longer: 50 cm instead of 34. They hang to its knees.
    - To reach out, it leans in: its shoulders come forward up to 45 cm.
    - A held thing is carried 0.76 m from the eye looking ahead, 0.90 m looking a little down and
      1.08 m looking well down. A person held things 0.9–1.05 m away.
    - The arms aim from where the leaning shoulders are, so the paws land on the grip.
    - In first person, the "ready" pose (paws up in the corners) is only for empty paws. While you
      hold something, your paws are where everyone else sees them: on it.
- **A sustained yank tears things out of its paws.** The beaver's reach is shorter (0.95 m with
  the lean, a person's is 1.04 m). The grab lets go when what you hold stays more than 1.25 m from
  your paws for 0.4 s (0.75 s for a person), or at once beyond 2.2 m, as before.
    - A violent flick stretches it past 1.25 m for about 0.5 s, so it drops the plank again (the
      original test, unchanged).
    - A sudden turn stretches it for under 0.1 s, and carrying while walking stays under 0.45 m:
      both keep hold.
- **Your first-person limbs** still have their own 1 cm lane that follows the camera every frame.

### Measured (`tests/unit/hands.test.ts`, now run for the beaver)

- Plank looking straight, a little down and well down, the crate and the bucket: both paw tips
  are within 4 cm of the grip's height and 3 cm of its depth, one either side of it. That holds in
  your own view and as others see you. The test's limits are 10 cm and 8 cm.

### What playing feels like now

- **The Timber Yard bridge** plays as before: stop 0.35–0.6 m back from the bank, look down, let
  go. The playthrough test is unchanged, with one exception.
    - Stepping up onto freshly laid beams stalls for about 5 s, with either body. It is a step-up
      issue in the character controller, and Epic 5's approach ramps will replace the bare beam ends.
    - The test's walk now allows for that stall (1,800 ticks instead of 900).
- **Throwing the bucket over the creek** works from the near abutment, as before.
- **Planks gripped off centre** tip about your paws, more the further out you grip them, while they
  hang free.
    - A 2.4 m plank held by its end hangs 2.2 m below your paws, further than a 1.4 m beaver can
      lift it. So its far end comes to rest on the ground (at 35°; held 0.45 m out it hangs free
      at 41°).
    - The test checks it rests on the ground and never sinks in. A person holds it clear, as before.
- **The ute:** look less far down at the door to get in (your eye is 1.22 m up, not 1.86 m). The
  seats were already set for a sitting beaver.

### Tests

- Unit tests pass with the beaver, and with the person.
- The flick, the G-plank distance (0.6 m), the bucket throw and the beam-laying stand-off are
  back to their original numbers.
- Two animation checks now compute what the arms should do from the body's reach, instead of the
  old fixed 0.26 m and "exactly level".
- The balance test lifts the plank as each body carries it. Its end case allows resting on the
  ground, and checks nothing sinks into it.
- Browser tests: see the PR.

## Epic 6: logging and the sawmill (2026-11-22)

East of the Timber Yard there is now a logging stand: six pines with an orange band round the
trunk. You can bring them down, carry the logs to a working sawmill and saw them into planks or
beams. The Valley has the same stand and sawmill where the yard is.

### How to play it

- **Chew a pine:** look at a banded trunk with empty hands and click (or E, RT, touch grab). Ten
  bites fell it (a bite every 0.3 s; two beavers chewing go twice as fast).
- **Chop with the axe:** the axe lies by the sawmill's infeed. Holding it, click a banded trunk:
  four blows fell it. Q (B on a pad) puts the axe down.
- **Read the lean, stand clear:** a tree falls away from the side you cut it from, pulled towards
  the way it leans by its weight. One tree in the stand leans so hard it falls its own way whatever
  you do. At 70 % it creaks and the toast says where it will fall ("It will fall to the
  north-east: stand clear!").
- **Move the log:** the felled trunk is a 113 kg log. Two beavers lift it together, one either side
  of its middle. Alone, chop it with the axe three times to buck it into two short logs (57 kg):
  one beaver carries those.
- **Saw it:** lay a log (or a short log) still, lengthways, in the sawmill's guide (the low rails on
  its east side) and let go. After half a second the sawmill takes it, the blade turns for 4 s and
  the pieces come out on the rack on the west side.
- **Planks or a beam:** grab the lever on the sawmill's north post to switch. Planks: three from a
  log, one from a short log. Beam: one 3.2 m beam from a whole log (a short log still makes a
  plank). They are ordinary planks and beams: build with them.
- **The lamp on the motor:** green ready, orange sawing, red stopped.

### What was built

- **Cut state (#55):** each stand tree has a cut (0–100 %) that bites and blows add to, drawn as a
  pale band of exposed wood round the trunk that widens as the cut deepens, and shown in the prompt
  ("Click to chew the pine · cut 40%").
- **Falling timber (#56):**
    - When the cut completes, the trunk above a 0.3 m stump becomes a physical log, once, exactly
      where it stood, starting from its lean plus a small push away from the cut.
    - Its weight biases the fall: stand trees lean (drawn leaning, up to about 6°) and the lean
      adds to the push.
    - The crown rides it and breaks off in a burst of needles as it lands.
    - The voxel tree leaves the static world and a stump with rings stays (the voxel worker reads
      the tree's state from the snapshots, so a guest's world shows the same).
    - Stand trees have no foliage collision: the needles never block a grab, stop a player or catch
      a falling trunk.
- **Sawmill (#57):**
    - Feed interlock: a log is taken only when it lies still, lengthways and unheld in the guide;
      once taken it leaves the physics world, so it can never be grabbed or sawn again. A second
      log waits in the guide until the first is done.
    - Safety interlocks: the blade stops while anyone stands at it ("Safety stop"), and pieces only
      come out where the rack is clear of bodies and players; otherwise the machine waits
      ("Outfeed blocked").
    - Planks or a beam, chosen with a lever.
    - Moving voxel parts: the turning blade, the lamp, a progress bar and the lever. The old
      decorative saw bench is gone.
- **Wood effects (#58):** chips at every bite and blow, needles when a crown breaks off or a stump
  regrows, sawdust while the blade runs. Pooled voxel particles worked out on each device; nothing
  extra is sent.
- **Resources and solo play (#59):**
    - A stump regrows into a full tree 45 s after felling, once its log has gone and nobody is
      standing there.
    - The yard's own logs come back to the log pile 20 s after being sawn.
    - Felled logs, short logs and sawn pieces lost in the creek go back to their pools.
    - Solo: fell with the axe, buck the log, carry the halves.
- **Simple tools:** the axe (quicker than chewing, and the only way to buck a log).
- **Online:** guests chew, chop, carry and saw through the same commands; prompts, the cut, felled
  trees and the sawmill's state reach them in the host's snapshots. A Valley snapshot grew from 734
  to 927 bytes (1,896 base64 characters with every pooled piece out at once; the budget is 4,096).

### Test results (actual)

`tests/unit/forestry-gate.test.ts` (4 tests) plays through player commands only: no prop is put
anywhere by hand and nobody is teleported. Both voxel sizes:

| Test                        | What happens, all by input                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Gate: two beavers**       | walk to tree 2, chew it down together; walk round the log, take it either side of its middle, carry it into the guide (never lower than 0.45 m above where it lay; the test asks for 0.3 m); 3 planks; one shoulders the yard's two beams across the creek, the other carries each plank out along the beams and lays it across them over the gap; a player walks over them to the far bank, no fall; the stump has regrown since its log was sawn |
| **Gate: solo**              | walk to the axe and pick it up, chop tree 4 down (4 blows), buck the log (3 blows), drop the axe, carry the west half into the guide: 1 plank                                                                                                                                                                                                                                                                                                      |
| Determinism                 | the same interleaved two-player bites and walks, run twice: every entity identical                                                                                                                                                                                                                                                                                                                                                                 |
| **Online (host and guest)** | over the real host/guest sessions: the guest walks to the axe, picks it up, chops tree 2 down and hears "Timber!"; host and guest carry the log into the guide; the guest's snapshots show the saw running (progress to over 90 %) and the 3 planks; the guest's own voxel world, fed from its snapshots, shows a stump where tree 2 stood and tree 1 still standing; the guest bucks a log on the pile and sees the two halves                    |

`tests/unit/forestry.test.ts` (20 tests) checks the parts. Some of these put a log in the guide or
a player beside a tree directly, to test one thing at a time:

| Test                            | Result                                                                                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stand layout                    | 3 m apart, clear of the scenery's crowns, a falling trunk stays inside the play area's walls                                                                                         |
| Chew an upright tree            | 10 bites; chewed from the west it falls east; the log lies along the fall                                                                                                            |
| Fall direction from eight sides | worst 1.4° from the prediction (the push plus the lean)                                                                                                                              |
| Weight                          | tree 0 (leans 0.11 rad north) chewed from the west falls north-east as predicted (58° from the push); chewed from the north it still falls north; an upright tree falls exactly away |
| Same cuts twice                 | identical log position                                                                                                                                                               |
| Two beavers chewing             | 5 bites each, under 2.6 s                                                                                                                                                            |
| Pressing every tick             | still one bite per 0.3 s                                                                                                                                                             |
| Axe                             | 4 blows fell a tree, 3 blows buck a log into two halves under 60 kg                                                                                                                  |
| Sawmill                         | a log in the guide gives 3 planks, once; 600 ticks later still 3; the pile's log comes back                                                                                          |
| Lever                           | grabbing it sets beams: a log gives one beam (beam-12), a short log still a plank; grab again: planks                                                                                |
| Two logs                        | the second waits and is sawn after the first                                                                                                                                         |
| A plank, a log across the guide | not taken                                                                                                                                                                            |
| Player at the blade             | saw stops (progress +<2 % in 2 s), carries on when they leave                                                                                                                        |
| Rack blocked                    | no planks, the machine waits; clear it and all 3 come out                                                                                                                            |
| Regrowth                        | no regrowth while the log still lies by the stump (regrowth after sawing: the gate test)                                                                                             |
| Lost log                        | a felled log in the creek returns to its pool                                                                                                                                        |
| Voxel worker                    | felled: every tree cell gone, stump drawn, ground untouched; regrown: identical to the start                                                                                         |
| Effects                         | 10 bites → 10 chip bursts; 1 needle burst; sawdust while sawing                                                                                                                      |
| The Valley                      | a stand tree falls there by chewing; the sawmill is there and its lever works                                                                                                        |
| Guest chewing                   | a guest's grab presses chew a tree down on the host; its snapshots show the tree felled                                                                                              |

- Unit tests: 374 pass (48 files, both voxel sizes).
- Browser test: in the Timber Yard, chew tree 2 down with injected clicks, then grab the sawmill's
  lever to set beams (screenshots in `test-results/logging-*.png`).
- Cost of a felling in the voxel worker (one-off, off the main thread): 83 ms to clear the tree and
  draw the stump at 5 cm, 134 ms to regrow it (18 and 22 ms at 10 cm).

### Known limits

- **One beaver cannot drag a whole log:** pulled by one end it tips up on the other instead of
  sliding. Buck it with the axe.
- **A log's foot can land on its own stump** and lie there tilted (up to about 15°).
- **The yard's creek (2.6 m) is wider than a plank (2.4 m):** planks deck the beams there (or make
  beams at the sawmill: a sawn beam spans it).
- **Pools can fill up:** with 15 sawn planks (or 4 sawn beams) lying about the sawmill waits, and
  with six felled logs lying about no more trees fall until one is sawn. The toasts say so.
- **A felling or a regrowth costs one slow voxel frame** (above) while the tree is re-drawn.
- **Far away in the Valley** (the coarse far lattice), felled stand trees still show standing.
- **No sawmill or chopping sounds yet** (they come with the shared sound effects).
- **Not tried on a real phone or pad.**

## Online: 8 players, reconnect, bad-network testing (2026-11-22, Epic 10)

Online games now take up to **8 players** (was 4). A guest whose connection drops, or who reloads the
page, gets their own player back. And there is now a way to test online play on a bad network on
purpose.

### What changed for players

- **8 players:** the host plus seven guests. Players appear in two rows of four beside the host, and
  never on top of someone already standing there (two players placed into each other used to stick
  together).
- **A full game:** you can still pick it from the list ("Watch abcd · 8/8 · full"). You watch the
  game and get the first place that frees up.
- **Dropping out:** if a guest's connection drops or they reload, the host keeps their player where
  it stood for **60 seconds**. Their player lets go of anything they were carrying (so a partner on
  the other end of a beam is not stuck) and gets out of the ute. The host sees "Player 3 lost their
  connection: keeping their place for a minute", then "Player 3 is back".
- **Coming back:** the same browser tab rejoins by itself after a reload and gets the same player.
  Nobody else can take a held place, and nobody can take the place of a player who is still
  connected.
- **The host going quiet:** guests see "Lost the host: reconnecting…" and wait up to 20 s before
  giving up. When the host stops hosting on purpose, guests leave straight away.
- **Round trip:** the Online panel shows each guest's round trip on the host, and your own on a
  guest.
- **Another version:** a game hosted by another version of the game (protocol 2 is this one) is
  listed as "another version of the game: reload both pages to play together", and can't be joined.
  The host never seats a guest of another version. The host also sends its world's entity layout
  (a short hash of the entity list): a guest whose build lists other entities applies none of the
  host's snapshots and leaves with the same message, so two builds can't garble each other's world.

### Testing on a bad network

- `?netsim=latency,jitter,loss` delays and drops everything this page sends. For example,
  `?net=local&netsim=150,100,0.1` gives 150–250 ms one way, with 10 % of updates lost.
- The same shim runs in unit tests on a virtual clock (`src/net/netsim.ts`).

### Test results (actual)

Unit tests, 100–300 ms one way with 10 % loss (`tests/unit/net-robust.test.ts`, both voxel sizes):

| Test                                                                       | Result                                                                                                       |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Join and walk; three one-frame jump presses                                | Exactly 3 jumps on the host                                                                                  |
| Host and guest lift the 113 kg log together                                | Both hold it, it rises over 0.4 m; the guest's one release press lets go                                     |
| Garbage input (NaN, 1e300, strings, reset requests)                        | Every position stays finite, no reset or drop test runs, lag reads "unknown"                                 |
| A guest drops, reloads, comes back                                         | Same player, within 0.3 m of where it stood; a newcomer meanwhile got a different place                      |
| A guest drops while carrying the bucket                                    | The bucket is let go at once; the place frees after the grace period                                         |
| 8 players walking, turning and jumping                                     | All 8 move; what each guest draws (every player, the bucket) matches the host to 2.8 cm, worst of 567 checks |
| A host that goes quiet, then comes back                                    | "Reconnecting", then reconnected and receiving again; gone for good, the guest gives up after 20 s           |
| A guest of a build with other entities                                     | Applies no snapshot and says it's another version                                                            |
| Largest host state: the Valley, 8 players, every entity drawn, long events | 2,841 bytes (the room allows 4,096)                                                                          |

The 2.8 cm is the straight line drawn between 20 Hz snapshots across a jump's take-off or landing;
the codec itself is good to 4 mm.

Host cost per tick with everyone walking (`node scripts/bench-net-host.ts`, Node on this container's
CPU; the budget is 16.7 ms). The host's published state peaked at 1,875 bytes in the Valley at 8.

| Level       | 1 player           | 4 players          | 8 players          | Snapshot at 8 |
| ----------- | ------------------ | ------------------ | ------------------ | ------------- |
| Timber Yard | 0.47 ms (p95 0.86) | 1.16 ms (p95 1.51) | 1.69 ms (p95 2.56) | 695 bytes     |
| The Valley  | 1.28 ms (p95 1.67) | 1.83 ms (p95 2.59) | 2.67 ms (p95 3.40) | 1,040 bytes   |

- Browser test: host and guest on `?netsim=150,100,0.1`. The round trip reads at least 250 ms.
  Player 2 walks 1.5 m off, the guest reloads, the host holds player 2 (`dropped` is `[1]`), and the
  reloaded page gets player 2 back within 0.5 m of where it stood (a fresh join appears beside the
  host). The four online browser tests, split screen, the Timber
  Yard and the ute tests pass.
- Unit tests: 354 pass.

### Known limits

- **Not tried with 8 real devices.** Eight beaver bodies on a phone guest are not measured, and the
  peer-to-peer mesh (each guest connects to every other player in the room) is not measured at 8.
- **The rejoin token is visible to the room.** Someone in the same private game could copy it and
  take a dropped player's place. That's low stakes for a co-op game with private codes.
- **A host reload ends the game**, because the world lives on the host. Guests see "The host left
  the game" after 20 s.

## Epic 4: the ute drives (2026-11-22)

You can now drive the ute in the Timber Yard and the Valley. A friend can ride along.

### How to play it

- **Get in:** look at the ute and click (or E, RT, touch grab).
    - From its right side you take the driver's seat (right-hand drive).
    - From its left side you take the passenger seat. If your seat is taken, you get the other one.
- **Drive:**
    - W/S throttle (throttle against the motion brakes first), A/D steer, Space brake.
    - On a pad: the left stick drives and steers, A brakes.
- **Get out:** click or E again. You step out beside your door.
- **Recover:** Q (B on a pad, drop on touch) puts the ute back where it last stood level on firm ground.
- **Parked:** with nobody driving, the handbrake holds it.

### What was built

- **Vehicle (#41):**
    - A dynamic chassis on four raycast wheels (Rapier's `DynamicRayCastVehicleController`).
    - Rear-wheel drive, top speed 10 m/s (4 m/s reversing). Steering lock eases off with speed.
    - About 760 kg, with the ballast low.
    - It never sleeps, because nothing would wake it when the ground under its wheel rays moves.
- **Collision shape:** follows the voxel model: lower body, hood and cab.
- **Cargo bed (#44):** an open bed with a floor, sides and a tailgate, so loads ride in it.
- **Seats (#42, #43):**
    - Driver on the right, passenger on the left, each eye under the cab roof.
    - Your view turns with the ute.
    - The host sends each player's seat to guests, so their prompts and view follow it too.
- **Gate (#45), wheels load what holds them up:**
    - Rapier pushes only the chassis.
    - Each tick, the opposite of each wheel's suspension impulse goes into the dynamic body that wheel stands on, at the contact point.
    - Tyre friction is shared between those bodies by wheel load.
- **Recovery (#46):**
    - Tipped over and still for 1.5 s, it rights itself where it lies.
    - The driver's drop puts it back at its last safe spot.
    - Out of the world, it goes back to its spawn.
    - Reset props also resets it.

### Test results (actual, `tests/unit/ute.test.ts`, both voxel sizes)

| Test                                                       | Result                                                                                        |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Parked on a free platform                                  | All 4 wheels on it; reaction / weight = **1.000**; the platform stays pressed onto the ground |
| Accelerating on a free platform on ice                     | The platform is pushed backwards (momentum is shared)                                         |
| A loose deck over a gap                                    | Carries the ute and stays on its supports                                                     |
| Two loose 20 cm beams over the Timber Yard creek           | Both take its weight out to mid-gap (over 0.3 × weight) and stay across                       |
| Top speed and braking                                      | 8.5 m/s after 6 s; stops in 1.2 s                                                             |
| A ~30 kg crate in the bed, after a 3 s run and a hard stop | Still in the bed: it slid forward to the cab end under braking                                |
| Rolled onto its roof                                       | Back on its wheels in 1.05 s                                                                  |
| Dropped nose-down in the creek, driver presses drop        | Back at its safe spot, upright, driver still seated                                           |

- Browser test: get in, drive with the keyboard, get out, in the Timber Yard.
- Unit tests: 326 pass.

### Known limits

- **Crossing loose 20 cm beams all the way:** past mid-gap, the tyres' sideways push walks an unfastened beam out from under a wheel. Fastening comes in Epic 5.
- **The cab is a solid box:** the seat view is placed inside it. Passengers can't walk inside the cab.
- **Not tried on a real phone or pad.** Driving with touch and pads is covered by the prompts and command mapping, not by a hands-on test.

## Your limbs stay with the camera (2026-11-22, owner report from a phone)

Owner: "The biggest problem is the player character being out of sync with the player camera."

- **Cause:** your first-person limbs are voxelized in a worker and only reach the screen when every
  lane has finished the voxel frame. The camera moves every render frame. On a phone, and in the
  Valley while the base lane builds tiles (up to 500–700 ms a frame in the container), the limbs
  fell behind the camera. The old fix sampled them up to 250 ms ahead, which can't cover a longer
  wait or a turn of the look.
- **Fix:** the limbs get a 1 cm lane of their own (`voxels-self`). Every render frame that lane is
  moved as one rigid piece, from the pose the limbs were built at to where you are now with your
  look's yaw (`VoxelClient.lockBody`, `bodyLockOffset`). Their animation (walk, reach) still
  updates with voxel frames. The look-ahead sampling is gone.
- **Tests:** a unit test that a limb point built at one pose lands where it should at the pose now;
  302 unit tests pass; the grid, first-person, Timber Yard, Valley and split-screen browser tests
  pass.

## Beams are shouldered: level 1's bridge can be built (2026-11-22, owner request)

Owner asked whether the Timber Yard is finishable. Played through with player inputs only, it
was, but only by throwing the bucket over: no beam could be laid across. Held by its end, a 36 kg
3.2 m beam needs 565 N m to stay level and the wrist gives 70, so it hung straight down; toppling it,
carrying it by the middle or sliding it out all fell short of the far abutment.

- **Fix:** beams are braced on the shoulder: their wrist strength is `GRAB.braceTorque` (700 N m,
  per body via `BodyOptions.wristTorque`). Take a beam by its end, turn to the creek (it turns with
  you), stop 0.35–0.6 m back from the bank, look down to lower it and let go: it lies across on both
  abutments. Planks keep the hand wrist and still tip when held off balance.
- **Tests:** two new input-only playthroughs of the yard: building the bridge with both beams and
  carrying the bucket across to the flag, and the bucket-throw shortcut. 300 unit tests pass.

## The Valley: the rest of the levels as one big map (2026-11-22, owner request)

Owner: "Let's do the rest of the levels (one big map). Make sure it works for multiplayer and
single player", with the world map (seven numbered areas).

- **One 224 × 224 m map** (`src/levels/valley.ts`), on the Levels menu as "The Valley · the whole
  journey". The route climbs from the yard to the summit, with a crossing that needs timber
  between areas:
    1. **Timber Yard:** the yard as it was, turned to face up the valley.
    2. **Shallow Creek:** the old bridge gap (2.4 m), the yard's own crossing.
    3. **Forest Road:** about 500 more trees, a log dump with three beams, and a culvert ditch
       (2.6 m at the road).
    4. **Gorge:** a 5.6 m gorge with a stone pier in the middle (two spans of 2.2 m), a snapped
       trestle, and a waterfall from the works' outfall.
    5. **Old Industrial Works:** a brick hall, a chimney, tanks, pipes, a tower crane with a hanging
       crate, and a 1.5 m retaining wall up to the upper yard. Six crates are there to stack.
    6. **Mountain Approach:** the road climbs in two pitches with a level bench at a crevasse
       (2.4 m), and there is snow above 13 m.
    7. **Flower Summit:** the giant flower in a ring of stones.
- **Stages:** the objective shows "k/7 Area · what to do". A flag in the stage's colour marks each
  goal, and a signpost marks each area. A bucket lost in a crossing comes back at the current
  stage's start, and players who fall with no safe ground near go back there too.
- **Streaming (ADR 0013):**
    - near tiles are built around each local camera at the player's voxel size;
    - a coarse 40 cm far lattice draws the rest of the map under fog;
    - tiles far behind are released, so memory stays bounded.
- **Multiplayer:**
    - the host runs the whole map's physics;
    - each guest streams around its own player, and the stage count travels in the host state;
    - a guest joining from another level reloads into the Valley.
- **Fixed on the way:** props more than 30 m from the yard's centre were silently sent back to their
  spawn by a fixed physics safety box. The box now covers the level.
- **Tests:**
    - `tests/unit/valley.test.ts`:
        - the route frame;
        - crossings run right across the valley;
        - a beam laid over each gap rests on both banks and the pier;
        - a tile builds the same alone and among neighbours;
        - streaming lets go of what it leaves;
        - stages complete only in order;
        - lost-bucket recovery;
        - every prop at rest;
        - snapshot positions far from the origin.
    - e2e:
        - single player: the Valley boots, stage 1 completes, and a teleport to the gorge streams the
          world in;
        - two tabs over the local transport: the guest's objective follows the host's stage.

## Settings menu (2026-11-22, owner request)

Owner: "Can I have a proper settings menu please. Accessible to both keyboard, mouse/gamepad/touch".

- **Opening it:** the **Settings** button (bottom left), `Esc`, or Start on any gamepad. In first
  person, `Esc` first releases the mouse (the browser takes that key press), and losing the mouse
  opens the menu. Solo play pauses while it is open; an online game keeps running.
- **Every input:**
    - mouse and touch: tap a tab or control. Targets are at least 44 px, and the dialog scrolls on
      short screens; on narrow screens each label sits above its control.
    - keyboard: arrow keys (up / down rows, left / right change), `Q` / `E` or Page Up / Down for
      sections, `Tab` cycles inside the dialog, `Enter` / `Space` press, `Esc` closes.
    - gamepad: D-pad or left stick (held: repeats), **A** press, **B** or Start close,
      **LB** / **RB** sections.
    - the current row is always highlighted, not only after keyboard use, so a pad player can see
      where they are.
- **While it is open,** the game gets no input: keys, mouse buttons, pad sticks and buttons are
  ignored, and the touch controls are hidden. The **A** that presses a menu button does not jump,
  and doesn't join a second player.
- **Sections:**
    - Game: resume, restart level, levels, play online, hide HUD, debug panel.
    - Controls: mouse sensitivity, invert mouse Y, gamepad look speed, invert gamepad Y, touch look
      speed (touch devices), over-the-shoulder camera.
    - Video: quality, voxel size (apply reloads; it moved here from the bottom-left box), look,
      field of view, camera bob & kick, leaves & particles.
    - Interface: text & menu size (80–160 %), control hints, reset all.
- **Saved** in local storage (`uncivil.settings`), only what differs from the defaults; bad or
  tampered data falls back to defaults. URL parameters (`?quality=`, `?look=`, `?bob=`, `?view=`)
  still override for one visit, without being saved. The debug panel and the `C` / `L` hotkeys
  change the same settings.
- **Voxel styling** (owner: "more like the voxel/grid theme … build up the corners"):
    - a 16×16-voxel frame (stepped corners, a bevel lit top-left and shaded bottom-right);
    - yellow L-blocks with bolts on each corner, one voxel proud of the frame, extruded in 3D: the
      face, three voxels of depth (a shaded right side and a dark underside, lit from the top left
      on every corner) and a shadow cast on the frame;
    - the whole face is the game's grey rock (owner: "the whole face look like the grey rock, with
      random depth across it and then inset the menu item faces"): a tileable 32×32-voxel patch
      of plates at random depths in the Rock palette, darker the deeper, with lit and shadowed
      step edges; the frame's bevel tints it at the edges;
    - each row, and the key-hint strip, is a slot cut into the rock: a dark floor, shadowed top
      and left walls, lit bottom and right ones, with rock between the slots;
    - buttons, tabs, switches, choices and sliders are blocks with stepped corners that press
      down. Focus shows as a voxel ring inside them.
    - `scripts/voxel-frame.mjs` generates the frame, corner and rock images (CSS data URIs).
- **Accessibility:** a real dialog (`role=dialog`, `aria-modal`). Tabs are `role=tab`; switches
  are `role=switch`; choices are radio groups; sliders give their value as text.
- **Tests:**
    - `tests/unit/settings.test.ts`: storage, clamping, junk and prototype-polluted data, URL
      overrides.
    - e2e: opens the menu with the mouse, `Esc` and a simulated gamepad, changes the field of view
      by keyboard and invert-Y by pad, and checks both survive a reload.

## Holding things in your hands (2026-11-21, owner request)

Owner: "It really needs to look like I am holding things with my arms".

- **Problem:** held things floated at the grab distance, eased in to 1.7 m from the eye. The arms
  are 0.84 m long, so they pointed at the object but stopped short of it.
- **Arm's length:** held things are now carried at the body's `holdReach` (arm's length + 6 cm)
  from the shoulders, for where you look (`handsHold` in `world.ts`).
    - Looking straight ahead, that is about 0.9 m from the eye; looking down, about 1.05 m.
    - Things grabbed from further away are drawn in at 3 m/s.
    - The mouse wheel can only bring them nearer.
    - Shared holds keep their distance: two carriers drawing a log in would pull it apart.
- **Both hands on it:** the arms aim at the grip, and the shoulders reach in by whatever the arm
  is short. The hands go either side of the grip: as wide as the thing (up to 0.35 m) for wide
  things, close together for small ones.
- **Leaning against a load keeps the hands on it:**
    - raised arms counter the torso's pitch;
    - the shoulders slide forward by what the lean takes back.
    - (Before, leaning back lifted the hands 20 cm off the grip.)
- **First person:** while you hold something, the arms drop their "ready" pose and aim at the
  object, the same as others see them.
- **Measured (`tests/unit/hands.test.ts`):** both hand tips are within 10 cm of the grip's height
  and 8 cm of its depth, either side of it. Checked for the plank at three look angles, the cube
  and the bucket, in your own view and as others see you.
- **The beaver body** keeps the old behaviour (`holdReach: Infinity`).

## Balance: where you grip something is where it turns (2026-11-21, owner request)

Owner: "Where I pick the logs up from should change their rotation point. Balance is a big part of
this game".

- **The grip was already the pivot:** the grab force acts at the point you grabbed. What was
  missing was a wrist. Heavy angular damping (6) kept everything level wherever you held it.
- **Now a wrist** (`wristTorque` in `src/sim/physics/grab.ts`, `applyWrist` in `world.ts`) holds
  the object at the angle you picked it up at, relative to which way you face.
    - It is a damped spring (2.2 Hz, critically damped), scaled by the body's inertia.
    - It is capped at 70 N·m, so the weight's twist about your hand decides what happens.
    - Angular damping on held things drops to 1.5. Things with a handle (the bucket) keep 6 and
      have no wrist: they hang from the handle.
- **Measured with the plank** (2.4 m), held up in front for two seconds:
    - gripped at its middle, it stays as picked up (within 4°);
    - 0.2 m off centre, it barely sags;
    - 0.45 m off, it tips about 45°;
    - by the end, it tips about 56° and hangs below the hand.
- **Shared holds:** each grip gives half a wrist's strength. Two carriers balance a log between
  them, and it doesn't roll in their hands.
- **Animation:** the wrist's load feeds the carry strain, so an unbalanced hold makes the body
  lean and tremble like a heavy one.
- **Tests:** `tests/unit/balance.test.ts` covers the wrist maths (shortest way round, damping, the
  cap, NaN safety) and the plank at four grips. It also checks the bucket has no wrist.
    - Co-op log test: the log resting on the bottom log is now taken off before the two-player lift.
      Before, whether the pair could lift the bottom log depended on how far the solo attempt had
      rolled it out from under the top one.

## Tall lanky people stand in for the beavers (2026-11-21, owner request, temporary)

Owner: "replace (temporarily) the beavers with people. But like tall lanky simple people. Think
Slenderman proportions".

- **`src/assets/person.ts`:** a 2 m person.
    - Small head, narrow torso, and very long thin arms and legs (fingertips just above the knee).
    - Hard hat and hi-vis vest, like the beavers.
    - Thin limbs use coverage25 sampling, so they stay solid on a 5–10 cm lattice.
    - Three new palette colours: skin, workwear and boot.
- **It uses the beaver's animation channels,** so grab, carry, throw, walk, the network and first
  person all work unchanged. It replaces the players' bodies and the River Lab's walking NPC.
- **One switch:** `PLAYER_BODY` in `src/assets/player-body.ts` picks the body, along with its eye
  height (1.86 m vs 1.22 m), shoulders, arm length and stride. Set it to `'beaver'` to undo.
- **Gameplay changes that come with the height:**
    - the eye is 64 cm higher;
    - things grabbed from further than 1.7 m ease in to 1.7 m (except while shared, or after a
      mouse-wheel change);
    - the collision capsule is unchanged (1.4 m).
- **Long arms nearly reach what you hold:** the plank floats about 40 cm past the fingertips (the
  beaver's gap was about a metre).
- **Tests:** the first-person body tests now run for both bodies. Two physics tests now aim from
  whatever eye height the body has. Measured with the person, the held bucket's tilt bound is 22°
  (20.0° measured). The whole unit suite passes with either body.

## Grab, carry and throw animation (2026-11-21, owner request)

Owner: "add some animation in for the carrying and grabbing of things… look and feel like a AAA game
that also just so happens to have this cool voxel pixel effect".

- **A body animator in the sim** (`src/sim/player-anim.ts`): springs towards pose targets, plus timed
  overlays on events. It runs at the fixed tick, so it is deterministic, and every player sees
  everyone's animation through four new beaver channels: reach, spread, lean and head pitch
  (`ANIM_MAX` is now 10).
- **Holding:**
    - the arms aim at the actual grip point, so a heavy log that sags pulls them down, and they
      spread for wide things;
    - the body leans back against the load, with a slight tremor under strain;
    - what you carry bobs with your step.
- **Grab:** a lunge towards the object, then a dip as its weight comes on (more for heavy things).
- **Other events:**
    - a missed grab swipes out and back;
    - a throw flings the arms up and lunges forward (the throw itself stays instant);
    - a drop lifts the paws slightly;
    - a hard landing dips the body forward.
- **The head follows where you look,** for other players to see.
- **First-person camera:** a small walk bob, and kicks on throws, landings and heavy loads, taken
  from your beaver's channels. _Camera bob & kick_ in the panel, or `?bob=off`, turns it off.
- **Seeing yourself:**
    - `C` watches your beaver from over its shoulder in first person;
    - `?view=side` gives a side-on view for screenshots.
- **Motions are exaggerated** (up to ~20 cm of lean or reach, 0.3–0.6 s) so they read on a 5–10 cm
  lattice rebuilt 20 times a second. Anything faster or smaller doesn't show.
- **Tests:** `tests/unit/player-anim.test.ts` (7 tests: aim, weight, spread, throw, miss, landing,
  bounded under random events).
- **Known limit:** things are held 1.3–1.5 m out (the grab distance), while the beaver's arms are
  34 cm long. The arms point at what you hold rather than touching it. Holding things closer would
  change how carrying plays, so that is the owner's call.

## Pixel look prototype (2026-11-21, owner request)

`?look=pixel`, `L`, or _Look_ in the debug panel's lighting section (`src/render/pixel-look.ts`):

- a quarter-resolution render with a nearest-neighbour upscale;
- silhouette outlines from depth, fading out between 25 and 60 m;
- posterized colour;
- lone sparkles and one-texel cracks filled in;
- bloom, vignette and MSAA turned off.

It is off by default.

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
