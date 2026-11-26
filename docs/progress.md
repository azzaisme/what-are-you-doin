# Progress log

## Epic 5, part 2: joints strain, creak and break (2026-11-23, #49 #50)

Nailed joints now carry measured loads and can fail. A joint that is working hard creaks, one close
to its limit groans, and an overloaded one cracks and lets go, never without a creak first. The
limits are an 8 mm spike in C24 softwood, taken from EN 1995-1-1.

### How to play it

- Build as before (F to nail). **Seat beams on both banks:** the stone seats carry the ute. Nailed
  at both ends with two nails each, the yard bridge carries the ute at an eighth of what its
  nails hold.
- **Nails hold pieces in place; the seats and faces carry the weight.** A beam that rests on both
  seats and is nailed at its near end only holds too (the right physics: its nails carry next to
  nothing). A beam that sticks out over the creek with nothing under its far end is held up by its
  nails alone, and breaks under the ute.
- **Spread your nails.** Two nails in a row resist a beam swinging round by their couple alone: a
  gust on a beam spiked at one end puts about 3.75 kN on each. Four nails, spread along and across
  the end, hold it.
- **Warnings:** listen and look. A joint under strain creaks and its nail heads turn amber. Close to
  breaking, it groans and the heads turn red. Every break comes at least 0.5 s after a creak, even
  a hard blow's ("Crack! A nailed joint gave way").
- **Holding a load near the limit wears a joint down** (fatigue), and given time it lets go.

### What was built

- **Strength (#49, `src/sim/joints/graph.ts`), EN 1995-1-1, characteristic values:**
    - shear per nail 4.0 kN: 8.2.2 (8.6 f), f_h,k = 15.4 MPa, M_y,Rk = 40.1 N m, 3.6 kN, plus the
      rope effect;
    - withdrawal per nail 2.0 kN: 8.3.2, f_ax,k = 20e-6 rho_k^2 = 2.45 MPa over 100 mm;
    - the two combined as squares: 8.3.3 (8.28);
    - no partial factor: the game breaks at the characteristic value. A design would allow
      kmod / gamma_M = 0.69 of it.
- **Measuring loads (`stress.ts`):**
    - Rapier reports no joint forces, so after every step the meter takes each nailed piece's change
      of momentum, less gravity, damping and the contacts that are not its own;
    - the contact at a joint's own faces, within 0.6 m of its nails, is part of the joint. Rapier's
      joint and contact fight over the same faces: a seated beam end read 18 kN of joint pulling
      against 20 kN of contact pushing. Only their sum is the joint's;
    - a loose piece lying on a nailed one (a log, a plank, the bucket) presses with what its own
      momentum says, not with Rapier's reported impulse. That impulse also holds Rapier's
      penetration correction, which moves nothing. The nailed deck's quiver keeps that correction
      busy: a still 1109 N log read about 1450 N, and the anchors carried 22.6 % too much. Each
      loose piece touching a jointed one has its reported contact impulses scaled to
      m dv - m g dt, along their sum. They are only ever scaled down, so an impact, which moves the
      piece, reads as reported;
    - where that does not pin down each joint's share, the share is the elastic one (Menabrea:
      least sum F^2/2k), using the same stiffnesses the joints' springs have;
    - each joint's force and moment split into: bearing on its faces (the timber carries it);
      withdrawal, including prying (T = along + |M| / reach, the reach being as far as both pieces'
      faces go that way); shear, less the faces' friction (0.5 of the bearing, timber on timber or
      stone); and the nails' own turn about their axis.
- **The joints (`joints.ts`):** each is a six-way spring, not a pin:
    - along every axis, the nails' slip modulus, K_ser = rho_m^1.5 d^0.8 / 30 = 1.5 kN/mm per nail
      (EN 1995-1-1 7.1). As rigid pins, two anchors on one beam fought over its length, and the beam
      jittered at 0.1 rad/s;
    - turning about the nails, their couple: K_ser x sum(lever^2 + r^2), lever 4 cm, r from the group's
      centre;
    - tipping across the nails, the faces' bedding: E_90,mean x I / t for C24 (370 MPa, a 20 x 15 cm
      face, 10 cm deep) = 2.1e5 N m/rad;
    - **the anchor cap (a simulation limit, not timber):** a joint into stone is held to what a 60 Hz
      step can follow, omega dt <= 2 on the piece's inertia about each axis. A beam's bedding about
      its own long axis (0.19 kg m2) rang at 1000 rad/s, and an idle beam nailed at one end rolled
      4 degrees onto its edge and back, reading 0.99 of its nails' strength. Its stone seat's contact
      holds that roll. Timber to timber is not capped: there the joint stands in for the faces
      (nailed timber gives up its contact, which fought the joint and shook a finished deck apart),
      so it keeps the full EN 1995 values.
- **Breaking (`breaking.ts`):**
    - load against capacity smoothed over 0.1 s;
    - creak at 55 %, groan at 80 %;
    - break past capacity, or on a blow of 2.5 x capacity two steps running, which cracks the joint:
      either way only BREAK.tell = 0.5 s after it creaked;
    - fatigue above half of capacity takes up to 60 % off its strength;
    - a new joint settles 0.25 s before it is rated.
- **Solver iterations for nailed pieces (`NAIL.solverIterations`):** each nailed piece gets 24
  more of Rapier's solver iterations than the world's 4. With the world's 4, the stiff timber
  springs on a 24 kg plank's roll never converged: an idle 8-plank deck kept quivering (up to 1.3
  rad/s), never slept and cost 1.16 ms a step, and under a 113 kg crate it walked the crate 5.4 cm
  in 10 s. Now both sleep within 3 s (0.23 and 0.20 ms a step). The springs are unchanged: timber is
  still uncapped. The cost is paid only while a deck is awake (below).
- **Pieces that sleep:** a still structure sleeps once its joints' loads are steady, and keeps what
  they carried. Steady means each joint's load is within 2 % of the piece's weight of its 0.25 s
  mean, and that mean has not moved by as much within the last 2 s (Rapier's time to sleep). Without
  that second check, a load growing slowly lagged its mean by less than the margin, and the piece
  slept through it. A piece that is not steady is woken every step, which restarts Rapier's sleep
  timer. A woken piece is read from its first step awake.
- **A beaver's weight (`world.ts`):** a kinematic character pressed on what it stood on only by the
  controller's push, about 0.8 of its weight, in fits, on every plank under its 0.6 m feet, and
  carried things weighed nothing. Now what is straight under its centre gets exactly its weight
  (60 kg, the same as it pushes with) plus its share of what it carries, and the controller's push
  is taken back: down and turning, and sideways too. A loose piece keeps the sideways push only
  when the controller walked into its side (contact normal under 45 degrees from level): a shove.
  Stepping onto a loose beam's end (contact normals 0.83 to 0.92 up) had walked the 36 kg beam 10 cm
  along at a stroll. A nailed piece gets none of the controller's shove: pressed against a nailed
  plank's edge, it read 1.5 kN on its nail.
- **Sounds (Epic 8's `sfx`):** creaks and snaps come from what every device sees (the strain levels
  and the nails' disappearance), rate-limited per joint.
- **Online:** guests get the same messages and sounds; a broken joint's nails disappear for them.

### Test results (actual, both voxel sizes; `breaking`, `joints-sleep`, `joints`, `yard-bridge`, `loose-loads`, `creep`)

| Test                                                                                                           | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cantilever off a stone block on four spikes, tip load 0 / 200 / 400 N                                          | Force 358 / 558 / 758 N (statics 358 / 558 / 758); withdrawal 1331 / 3073 / 4815 N (statics 1432 / 3232 / 5032, band 0.9 to 1.1)                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| A beam hung on one spike into a stone pier, 300 N                                                              | Across the spike 658 N (statics 658), withdrawal 485 N (statics 500), no moment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| One spike: self weight; tip loads for 0.85 and 1.15 of its withdrawal                                          | 0.71 of capacity; held at 0.85; creaked at 0.35 s, broke at 0.85 s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Fatigue on a steady load, u = 0.6 / 0.75 / 0.9                                                                 | Broke at 13.02 / 5.40 / 2.03 s (the law: 12.74 / 5.28 / 1.99 s)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Cantilever on two spikes at u 0.71; at u 0.42                                                                  | First creak 0.7 s, broke at 7.0 s; no fatigue after 30 s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| A blow past 2.5 x capacity, two steps running                                                                  | Creaks, breaks exactly 0.5 s later, under no load                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Proper yard bridge under the ute** (both ends, two nails each)                                               | Peak **0.12** of capacity; no creak                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Four beavers on a nailed deck patch                                                                            | The beams hold it up by 2354 N more (their weight 2354 N); peak 0.00                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Underbuilt:** beams laid off the lip short of the far seat, four nails each                                  | Peak 3.17; creak at tick 218, breaks at 318 and 329 (first break 1.67 s after the creak); the ute drops into the creek                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Settling: nailed at the near end, the far end propped 2 mm, the prop taken away                                | Peak 0.002, no creak                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Cantilever at rest                                                                                             | Turns 0.0000 rad/s step to step; Rapier reports under 0.001 rad/s (below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| The faces' radius at 0.5 / 0.6 / 0.8 m                                                                         | Identical: withdrawal 3073 N, proper bridge peak 0.12                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| A sleeping bridge, then the ute; the reference kept awake every step                                           | Wakes; peak 0.12, the same as the bridge kept awake (0.12)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| A beaver onto a sleeping beam                                                                                  | Wakes; the joints hold 1304 N, the beams and the beaver (1304 N)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| A beaver standing still on a beam for 8 s                                                                      | Never asleep; the joints hold 1304 N, give or take 0 N, once something else wakes it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| A load growing slowly on one spike, applied without waking it                                                  | Never asleep (0 steps); creak at 0.4 s, break at 4.6 s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| A log dropped 1.5 m onto a sleeping bridge                                                                     | Peak 0.130 asleep first, 0.135 kept awake every step; a reading that skipped a woken piece's first three steps read 0.023 (the test fails on it)                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Joint springs                                                                                                  | Timber to timber: the EN 1995 values as they stand. Stone anchors: no stiffer than omega dt = 2 (the stiffest at 2.000)                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Gate, by input:** beams, an 11-plank nailed deck, both ends anchored, the ute driven from where it is parked | 4 anchors, 22 deck joints, every nail the builder set out to drive (34: four across each near end, two across each far end, two per plank; a far-end nail refused where a beam lies 5.6 cm off its seat's flat is moved, as a player would); planks within 0.2 cm of the deck plane, 4.2 cm of their spots, all on the first try; floods moved the crossing **0.5 and 0.0 cm**; standing empty a minute: peak **0.008**, no creak; every step from the finished deck to the far bank, no nailed plank sank into a beam or lifted off it by more than 1.2 mm; the ute reached the far bank |
| The same deck, plank nails pulled                                                                              | The ute shoves its planks up to 93.5 cm                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Online, host and 3 guests, the underbuilt bridge                                                               | Guests see strain level 2, the creak and the break; their nails go                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Knock-on:** a beam hung on a pier by two spikes, 2 kN hanging from it; spike A worn out by earlier strain    | A breaks at 0.80 s; B, at 0.44 until then, is thrown far past its strength (34.8 at the swing), creaks at 0.83 s and breaks at 1.33 s. With A not worn: A holds at 0.57, B stays at 0.44, no break, no warning from B in 8 s                                                                                                                                                                                                                                                                                                                                                              |
| **Debris:** the underbuilt bridge after it gives way                                                           | The beams stop 1.02 and 3.30 s after the first break, the ute 0.93 s; nothing faster than 4.72 m/s (falling into the creek); no speed clamps                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **The extra solver iterations, guarded:** an 8-plank deck idle, then under a 113 kg crate                      | Idle, asleep after 1.37 s; under the crate, asleep after 3.62 s, the crate moving 0.51 cm in 10 s. With `NAIL.solverIterations` at 0, neither sleeps and the crate moves 3.61 cm: the test fails                                                                                                                                                                                                                                                                                                                                                                                          |

- Unit tests: 808 pass (96 files, both voxel sizes). Browser tests: listed in the pull request.
- Other epics' tests changed, each for a measured reason:
    - Epic 7's bucket throw is thrown at 0.26, 0.28 and 0.30, and every one lands in the goal,
      empty. A single aim at 0.3 had landed by the goal's far edge, and once, with the player 5 mm
      further on after walking over the yard's beams with their weight on them, bounced out;
    - Epic 8's flood rebuild aims at where the washed-up beam's end really is (it lies 4.6 degrees
      off square, 11 cm off its centre line at the grip);
    - Epic 6's forestry follow-up walks its original way again. The waypoint round the yard's beams
      that an earlier version of this work added is gone: the controller no longer shoves a loose
      beam a beaver steps onto. The yard's beams now move 5.6 and 0.1 mm on that walk (10.3 cm
      before the fix);
    - the gate's builder spreads four nails across each beam's near end and two across each far
      end. When its shuffle stalls at the bank's edge with a plank held short, it steps up onto
      the deck firmly, as a player does. At its 30 to 60 % creep the controller slid back off the
      first plank's rounded edge, so the player let go 15 cm short, and the third plank landed on
      its edge. Before: plank 3 landed on its edge twice and went down on the third try. After:
      every plank lands on the first try, within 0.2 cm of the deck plane. The assertions are
      unchanged.

### Loose loads on the bridge (`loose-loads.test.ts`, found building the #51 overlay)

The yard bridge, nailed at both ends, with one deck plank, or a deck of eight, nailed across it
mid-span. Each load lies on it. The four anchors' upward force is averaged over a second, against
the weight of everything on them:

| Load                     | One deck plank            | Eight deck planks         |
| ------------------------ | ------------------------- | ------------------------- |
| Nothing                  | 949 N of 951 N (-0.2 %)   | 2598 N of 2599 N (-0.0 %) |
| The log (1109 N)         | 2056 N of 2061 N (-0.2 %) | 3703 N of 3709 N (-0.2 %) |
| A loose plank (235 N)    | 1182 N of 1187 N (-0.4 %) | 2834 N of 2835 N (-0.0 %) |
| The bucket, full (113 N) | 1063 N of 1064 N (-0.1 %) | 2712 N of 2712 N (-0.0 %) |

- Rapier's reported contact impulse holds its penetration correction too, which moves nothing.
  While the deck quivered, that read a still log at 1.3 x its weight, and the anchors carried
  23 % too much (the audit: 1366 N against 1109 N on an 8-plank deck). Converged, a still load
  reads true as reported. A moving one does not: on the one-plank deck the log rolls 76 cm along
  the beams' 6 % slope, and read as reported the anchors carry 20.0 % too much. So the meter
  scales each loose piece's contacts to its own momentum, m dv - m g dt, along their sum, never
  up. Without that, the test fails.
- A round log cannot rest on this deck: the beams sit 11 mm apart in height, and the deck rises
  6 % along the bridge, so a log rolls off it. The resting heavy load in the sleep measurements
  is a 113 kg crate.
- A log dropped 1.5 m onto mid-span peaks at 0.031 utilization and 400 N of joint force, scaled
  or not: the rescale hides no impact.

### Friction creep, measured in play (`creep.test.ts`)

Rapier's friction does not quite stick under a steady sideways load. A beam nailed at its near end
only, pushed sideways at its middle with 400 N held for 3 s, swung 55 mm, about what the nails'
spring alone allows (57 mm), though its far seat's friction (486 N m) should have held the push's
476 N m. On a properly built bridge it does not show:

- four beavers standing on the decked bridge for 60 s: no piece moved more than 0.2 mm;
- then the ute over it ten times (all ten reached the far bank): no piece moved more than 0.2 mm.

### Performance

- An idle finished deck sleeps: 0.23 ms a step for an 8-plank yard deck (it was 1.16 ms, awake
  all the time).
- Kept awake, an 8-plank deck costs 2.24 ms a step with the extra iterations, against 1.44 ms
  without.
- The Valley's worst case, measured: all 12 of its beams and 13 planks nailed into rafts, 21
  joints, everything kept awake: 2.92 ms a step (2.80 ms without the extra iterations; 1.14 ms with
  nothing nailed). Within a 16.7 ms frame.

### #115's claims, measured again

- **Joint stiffness:** #115 had a fixed 200 kN m/rad per nail for every turn. A turn flat about
  the nails is now their couple (K_ser x sum(lever^2 + r^2)), so one nail is nearly a pivot. At
  20 N, one nail timber to timber turns 27.88 mrad (M/k 28.61), four 1.73 (1.74); into stone, 50 N,
  61.16 (59.26) and 2.45 (2.47). Under loads that turn them well over (one nail at 100 N: 122.1
  mrad; four at 400 N: 19.6 mrad), four nails are 25.0 x as stiff as one, as simulated (their
  couples: 24.0 x).
- **A nailed beam under a 400 N shove for a second:** #115 said under 1 cm. Nailed at both ends
  (by input, from both banks), the beams move 0.1 mm. Nailed at one end only, a beam swings on its
  two nails' couple: with the far seat made frictionless, 83.0 and 88.2 mm under a held shove,
  against the spring statics' 87.0 and 86.7 mm. The 17.7 mm this log gave before was an
  unconverged solve, which made the joint act stiffer than it is; #115's 1 cm came from its stiff
  turn spring.
- **The nailed crossing:** the ute reaches the far bank; the beams drift 2 mm and 2 mm (#115: 2 and
  3 mm).
- **Nailed against loose:** a 400 N shove after the crossing moves loose beams 201 mm and nailed
  ones 0.1 mm (#115: 0.2 mm). In the gate, the same deck with its plank nails pulled shoves its
  planks up to 93.5 cm (#115: 361 cm) and the ute does not get over; nailed, 0.0 cm.
- **Each beam has two ground anchors**, one into each bank, and the gate's ute reaches the far bank:
  both still hold.

### Known limits

- Rapier's friction creeps under a steady sideways load (above). In play it moved nothing more than
  0.2 mm; a beam nailed at one end only and pushed hard does swing on its nails.
- A round log rolls on the bridge's 6 % slope, as it would.
- Pieces are rigid: a joint's warning is the creak, the nail colour and the message, not a bend.
- The one-way tipping spring (faces that push but do not pull) was tried and dropped: it ratcheted
  shut on vibration, and the settling it was for is the nails being pried, which they are.

## Credits and licences (2026-11-23, Epic 10, #104)

The game now says what it is made with, and ships the licence notices its parts ask for.

- **In the game:** Settings → Game → **Credits & licences…** opens a dialog with three sections:
    - **The game's own work:** the code, levels, voxel models and animation; every sound
      (synthesised in code, no recordings); and the text, which uses your device's fonts.
    - **Made with:**

        | Package           | Licence    | What it does                                         |
        | ----------------- | ---------- | ---------------------------------------------------- |
        | PlayCanvas Engine | MIT        | the 3D engine, and its camera, sky and water scripts |
        | Rapier            | Apache-2.0 | physics                                              |
        | Trystero          | MIT        | connects players peer to peer                        |
        | noble-secp256k1   | MIT        | signs the matchmaking messages (used by Trystero)    |

    - **Online services:** public Nostr relays help players find each other, and a TURN relay is
      used if one is configured.
- **Full licence texts:** the build writes `third-party-licenses.txt` beside the game (19 KB),
  with every bundled package's name, version, licence and licence text, read from the installed
  packages. The dialog links to it. Minifying drops the notices from the code, and MIT and
  Apache-2.0 ask for them to travel with it.
- **Kept honest:** a unit test fails if a production dependency is added without a credit, or if
  its licence differs from the one credited. Type-only packages (`@types/webxr`, `@webgpu/types`)
  put no code in the build and are left out. Vite, a development package, is included: its small
  module-preload helper is bundled. Only Vite's own MIT notice is shipped, not the licences of the
  tools Vite bundles into itself.
- **Tests:**
    - unit (`tests/unit/credits.test.ts`): the credits match the production packages and their
      licences, and each licence text is in the file;
    - browser, inside the itch embed: the dialog lists all five, the licence file loads from
      its relative URL with the Apache and MIT texts, and Esc closes the credits but not the menu.
- **Not decided here:** the game's own licence. The repository has none; that's the owner's
  choice.

## The game in itch's embed: checked in the browser (2026-11-23, Epic 10, #103)

itch.io shows the game in a cross-origin iframe on its own page. New browser tests play it that way
on every pull request into `main`, and three things changed for players.

### What changed for players

- **Full screen from inside the game:** Settings → Game → **Full screen**. Handy on phones, where
  itch's own button is small. It's only offered where the page around the game allows full screen.
  A test checks it's hidden when the embed forbids it.
- **Switching tabs in a solo game:** the game stops at the menu (paused). You come back to it
  waiting instead of mid-fall. The sound pauses too (it did before).
- **Online, the host switches tabs:** a page in the background draws no frames, so the host's game
  may stop for everyone. Guests are now told: "The host's game is in the background: it may stop
  until they come back". Then "The host is back".

### What happens when the host stays hidden for minutes

Browsers throttle a hidden page's timers. After 5 minutes, chained timers run about once a minute.

- **Peer to peer (itch.io):** Trystero drops a peer only when its WebRTC connection fails or closes,
  and the browser keeps that connection alive itself, whatever the page's timers do. Our channel has
  no timeout of its own, so guests stay in the game however long the host is away. If the browser
  discards the hidden tab (phones do) or the network drops, the connection closes. Guests then see
  "reconnecting" and leave after 20 s.
  Shown in `tests/unit/hidden-host.test.ts` with Trystero replaced by an in-memory stand-in on fake
  timers: the host sends nothing for 15 minutes, the guest receives nothing and stays; then the
  connection closes and the guest leaves after 20 s.
- **The local test transport (`?net=local`)** used to forget a page silent for 10 s, which would
  have dropped a throttled host. A page now says when it is hidden, and is then kept for 10 minutes.
  Tested on fake timers: a silent visible page goes after 10 s, a silent hidden one stays 9 minutes
  and goes after 10.

### What the embed tests check (`tests/e2e/embed.spec.ts`, actual results)

The setup:

- A stand-in itch page on `itch.test` frames the game on `game.test` (routed to the build).
- The iframe grants `autoplay; fullscreen *; gamepad`: the features the game uses, as itch's embed
  is understood to grant them. This was **not** checked against the live itch.io page, because this
  environment can't reach itch.io. Full screen is also tested with an embed that forbids it.
- Chrome blocks sound until a gesture. This Chrome does so by default; the `--autoplay-policy=user-gesture-required` flag is a safeguard for browsers whose default allows autoplay, so the asserts don't depend on it.
- The browser's own audio state is recorded by a script that runs at page load, before any test
  code.

| Check                                       | Result                                                                                                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before any click                            | No user activation at load; an AudioContext made then is suspended; no pointer lock; canvas 640 × 360                                                         |
| The bucket under the crosshair, first click | Pointer lock taken, the game's AudioContext running, the bucket **not** grabbed (still the target)                                                            |
| Esc (a real key press)                      | The menu opens and the mouse is released (here by the game's own Esc handling: headless Chrome passes Esc to the page); Resume takes it back, nothing grabbed |
| The page resizes the frame                  | Canvas 960 × 540, HUD inside                                                                                                                                  |
| itch's full screen button                   | Canvas 1280 × 720, the menu opens (the mouse was released); back to 960 × 540                                                                                 |
| Settings → Full screen                      | The game itself goes full screen and back; the switch shows On, then Off                                                                                      |
| An embed without full screen                | No Full screen switch in Settings                                                                                                                             |
| Tab hidden / shown                          | Sound suspended / running; the solo game paused at the menu                                                                                                   |
| Online, host hidden / shown                 | The guest's status and toast say the host is in the background, then back                                                                                     |
| Online, guest's tab closes                  | The host holds player 2 (`dropped` is `[1]`)                                                                                                                  |
| Online, host's tab closes                   | The guest shows "reconnecting", then after 20 s "The host left the game"                                                                                      |

- Three embed tests, and one for the credits (below), pass locally with no console errors or
  warnings.
- Unit test (`tests/unit/host-away.test.ts`): the host's away flag reaches the guest and clears.
- `docs/releasing.md` lists the embed checks.

### Known limits

- **Headless Chrome never hides a tab.** The test hides the page the way the browser announces it
  (the visibility state and a `visibilitychange` event). What a real background tab does to frames
  isn't reproduced: none are drawn, and when the page is back the game catches up at most 4 ticks
  (the rest are skipped).
- **The test pages are plain `http`.** itch serves the game over `https`. Features that need a
  secure context, such as peer-to-peer online play, aren't covered by these tests. The online
  embed test uses the local test transport.
- **Not yet tried on the real itch.io page** in Safari, Firefox or on a phone.

## Weather along the Valley, and its flood (2026-11-22, Epic 9, towards #88)

Each Valley area past the creek now gets its own weather once per run. It comes a seeded 4–22 s
after the first player gets there. The hazard director runs the weather that is a hazard, so it
takes turns with the flood, the gust and the handbrake prank: only one hazard at a time, with a
15 s quiet spell after each. Each hazard has a way to beat it, and a test plays it out by input.

- **Rain on the Forest Road: wet timber slips.** While it rains, a player under it grips with
  less force. It scales with the rain's strength: at full rain a grip gives about 400 N instead
  of 650 N.
    - Alone, a beaver carrying a heavy beam from the log dump up the road lost it after 1.43 m.
      The same carry in the dry held all 12 m.
    - Two beavers carrying it together held it all the way in the rain.
    - Carrying it lower alone is no reliable answer. Of ten heights tried (view pitch −0.25 to
      −1.2), only −1.0 held all the way; the others slipped within 1.6 m. So the toast only says
      what works: "Wet timber slips: carry heavy pieces together". A test checks that, of six of
      those heights, at most one holds.
    - A guest's carry slips the same way: the host decides everyone's grip.
    - The river also rises 0.35 m in the rain, but that is only scenery: it reaches no bridge.
- **A fog bank on the mountain road.** At full strength the view closes in to the near world's
  edge: 24 m on Low, 30 m on High (its own end).
    - The fog fully covers the near world's edge on both presets (opacity at the edge 1.0), so
      the coarse far ground behind it never shows through.
    - It only hangs over its own area. The summit and its flower stay clear.
    - **The sky turns the fog colour too.** At full fog the far world had shown as fog-coloured
      outlines against a blue sky. Now a dome round the camera, far beyond the fog's end, is
      fogged out like the far world and fades in as the fog closes in. A browser test measures the
      colour where the far landmarks stand at full fog on Low: ΔE under 3 (it was about 18).
    - Played: in the fog, a beaver walked the 27.5 m stretch by input, steering only by the edge
      posts it could pick out (fog under 0.9). It never strayed more than 0.80 m from the road's
      middle, with no falls.
    - When it lifts, the view is back to the level's own.
- **Mist over the gorge: atmosphere, not a hazard.** It closes the view in like the fog, but
  there is nothing to beat. So it comes whatever else is going on, holds nothing up, and says
  nothing.
- **A snow squall at the crevasse.** A crosswind (up to 1000 N) pushes carried planks across the
  road, like a weaker version of the Timber Yard's gust. All three cases start with the plank
  picked up by input:
    - carried at chest height alone, it was torn away (692 N against a 650 N grip);
    - carried low, the push was 200 N, and it held;
    - carried by two players, it held at 1000 N (two grips hold 1300 N).
- **The Timber Yard's flood now happens at Shallow Creek too.** It is the same flood on the same
  crossing, turned with the yard.
    - Played: the flood washes both beams off and leaves them downstream on the near bank. A
      beaver fetches them, rebuilds and carries the bucket to the far flag, all by input.
    - The flood can leave a beam lying askew (13° in the test), so the player squares it up
      before laying it, as a player would.
    - **Fixed:** the Valley's water area covers the whole map, and the Timber Yard's ground
      (0.4 m) is lower than the flood's peak (0.6 m). So the flood had been floating loose props
      in the yard, with the water drawn over it. Now the flood's lift and current keep to the
      creek's channel, and the drawn surface stops just under the banks.
    - In a test, nine props lying in the yard didn't move during a flood.
    - It is just as strong: the bridge floated off at the same tick (1175) as before.
- **One at a time (tested):**
    - a bridge finished in the rain waits for it and the quiet spell;
    - rain waits out a flood;
    - the aimed gust never comes during weather;
    - the fog and the handbrake prank each wait for the other.
- **Online:** guests get the weather's area and strength from the host (tested through real host
  and guest sessions).
    - An older host sends neither, and that reads as no weather.
    - The Timber Yard sends nothing new.
- **On screen:** rain and snow fall round the camera as voxel particles (at most 90 cells). Mist
  and fog are drawn with the fog alone.
- **Seen in a real browser** (`docs/screenshots/epic9/weather-*.jpg`): each area at full
  strength, at Low and High.
    - The screenshots switch each weather on with a debug hook (`__riverLab.weather(n)`), which
      waits for the same moment any hazard would. It refuses in the grace period, during another
      hazard, in its quiet spell and over other weather (tested). The browser test seeks past the
      grace period first, which steps the simulation without drawing.
    - They come from a committed browser test, `tests/e2e/weather.spec.ts`
      (`WEATHER_SHOTS=1`).
- **Known visuals:**
    - The fog fades in with the frame time, which is capped. At normal frame rates it is most of
      the way in about 4 s; in software rendering it takes much longer.
    - At the flood's peak, a beam floating off the caps sits about 0.2 m above the drawn water.
    - The rain's rise lifts the drawn water everywhere, so the gorge's waterfall foam sits a
      little under the surface while it rains.
- **Timber Yard unchanged:** all its hazard tests pass untouched.

## Epic 8: a tree falls towards the ute (2026-11-22, #74)

The logging stand can now fight back. Take a bite out of a stand tree with the ute parked close
by, and the pine leans towards the ute.

- **When:** a player bites or chops a stand tree while the ute stands within 5.5 m of it (trunk to
  the ute's nearer end). Only a fresh bite or blow sets it off: a tree cut a little during the quiet
  start, or left half cut, says nothing until someone cuts it again.
- **The tell:** at that bite, a crack (a snap and a low creak) and a toast: "The pine is leaning
  towards the ute! Move the ute, or cut from its side so it falls away." Then the whole tree leans
  over towards the ute, to 0.2 rad (about 11°, its top moving about 1.4 m) over the tell, with a
  shake, and sheds needles on that side every half second with a creak each time. It stays leaning
  until it falls, and stands back up if the ute is moved out of reach or the hazard is given up.
  The voxel worker takes the static tree away while the tree's marker draws it tilted, from its
  channels in the snapshots, so a guest sees it too. Tested on the host and the guest (the drawn
  crown moves towards the ute and further over time), in the worker (taken away, put back), and
  in a browser test with a screenshot of the lean.
- **Time to react: 7 s.** The tree can't fall sooner, however fast it is chewed: it hangs on its
  last fibres, and the next bite after the tell fells it. Measured by input: from the crack, a
  player at the tree walks to the ute, gets in and drives it out of reach in 5.0 s. The other 2 s
  are for reading the toast.
- **What happens:** while the ute is in reach, the tree's weight shifts towards the ute: its own
  lean is replaced by a lean of 0.035 rad towards the ute.
    - Cut from the far side, it comes down on the ute (tested: within 10°, on tree 1 and on the
      leaning trees 0, 2 and 5).
    - Cut square to the ute, it is pulled round towards it (tested: about 63° from the ute, at
      least 20° nearer than the same cut with no hazard).
- **Counterplay, true of every tree in the stand, each tested by player input:**
    - **Cut from the ute's side:** the cut's push (0.07) beats the lean, whatever the tree's own
      lean, so it falls straight away from the ute. Tested on all six trees, the leaning ones too:
      more than 160° from the ute.
    - **Move the ute:** at the crack, walk to the ute, drive it out of reach, walk back and finish
      the tree. It falls as the same cut does with no hazard (tested: within 5°).
    - **A rope** waits for ropes.
- **Budget, tested so that removing each check fails a test:**
    - not in the first 20 s;
    - not within 60 s of the last one ending, even once the 15 s quiet spell is over (a cut 20 s
      after gives nothing; the second cracks on the first bite after the 60 s);
    - at most two (a third tree cut after another 60 s gives nothing);
    - none while another hazard runs (a tree cut during the flood's warning brings nothing).
- **Online, tested:** the guest gets the toast (and so the crack, which plays from it), sees the
  tree lean over towards the ute and the trunk come down on it, all in the host's snapshots. A
  guest who joins mid-tell sees the lean but missed the toast.
- **The creak at 70% cut** names no direction while the hazard pulls the tree, because the ute
  could still move ("The pine creaks: stand clear!").
- **Playtest log:** the summary counts falling trees, and the script says what to watch for.
- **Code:** `src/sim/hazard-tree.ts`, with three small hooks in the forestry (an extra lean on a
  fall, a hold on it, the lean on the marker), four more marker channels, the leaning tree drawn
  by the stand marker (`src/assets/forestry.ts`) while the worker leaves it out of the static layer,
  the needles in `src/fx/wood-fx.ts`, a few lines in the director, and a `placeUte` test hook.

## Epic 5, part 1: nails and the joint graph (2026-11-22)

You can now nail timber together, or nail it down to stone and ground. In the Timber Yard you can
build a real bridge, beams plus a nailed plank deck, and drive the ute over it.

### How to play it

- **Nail:** look at a plank, beam, log or crate and press **F** (**LB** on a pad, **Nail** on touch;
  F and LB can be rebound in the controls settings like any other action).
    - The nail goes in along your view. It must pass through the piece and bite into what is behind
      it: more timber, or stone / ground (an anchor). Trees are not anchors (they can be felled).
    - Look at it square on: within about 35° of straight into the face. Stand close and look down.
    - The prompt says what a blow would do: "F to nail", or why not ("gap too wide: close them up
      first", "hold it still", "nail it square on", "too thick to nail through here", "already
      nailed here", "can't nail into that", "nothing behind it to nail into").
    - A green outline marks where the nail would go (red when it would not hold). In split screen,
      each player sees their own.
    - A nail head shows as one dark cell on the piece.
- **Solo:** you can nail a piece you are holding. You let go once it is nailed.
- **Build the yard bridge:**
    1. Shoulder both beams onto the stone seats, about 1.1 m apart.
    2. Nail each beam's near end down.
    3. Carry planks from the two stacks (a new one stands by the bridge) and lay them across both
       beams, a plank's width apart. Nail each plank to both beams.
    4. Walk out on your deck and nail the beams' far ends.
    5. Finish the deck and drive the ute over. A stone lip and an earth ramp at each bank bring the
       road up to the bridge.

### What was built

- **Joint graph (#47, `src/sim/joints/graph.ts`):** each connection stores the two bodies, the
  anchor point on each, the type (nail or ground anchor), stiffness, strength, fatigue, and its
  nail heads.
    - One connection per pair of pieces. Another nail at a new spot reinforces it (strength and
      stiffness grow with nails, up to 4); a nail at the same spot is refused.
    - Ground is not one place: nails into stone more than 0.5 m apart make separate anchors, so a
      beam can be anchored at both ends.
    - The graph knows which pieces hang together and whether that group is anchored.
- **Joints flex by their stiffness:**
    - each joint holds its anchor points together rigidly;
    - its bending springs back with 200 kN m/rad per nail (× 0.8 timber to timber, × 1 into
      stone), so one nail flexes four times as much as four. (Since part 2: the EN 1995 slip
      modulus and bedding, see "#115's claims, measured again" there.)
- **Hammer (#48, `src/sim/joints/joints.ts`):** the prompt and the blow run the same test:
    - a 30 cm nail from where you look;
    - it must pass through the piece and bite at least 4 cm into the next;
    - the gap between them may be at most 5 cm (no fastening across thin air);
    - within 35° of square on;
    - the pieces must not be sliding against each other;
    - no kinematic bodies, no ute, no non-timber, no trees.
    - A nailed timber-to-timber pair stops colliding (they were touching already). A piece put
      somewhere by hand (reset props, recovery, falling out of the world) comes loose first.
- **Timber Yard (level tweak):**
    - the stone seats under the beams run up to a stone lip, flush with the top of beams laid on
      them;
    - a packed-earth ramp leads up to each lip;
    - seven more planks are stacked by the bridge for a deck.
    - The bucket-throw and beam playthroughs still pass. The Valley's copy of the yard has the lips
      and ramps but not the extra planks: the Valley crossings come in #54.
- **Online:** guests can nail (the host checks it like any other command). The host sends the
  nails to guests whenever they change (10 bytes a nail, at most 64), and each player's hammer
  prompt rides with the HUD.

### Test results (actual, `tests/unit/joints.test.ts` and `yard-bridge.test.ts`, both voxel sizes)

| Test                                                                                                                               | Result                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Gate, inputs only:** walk to each beam and stack, lay and nail beams and an 11-plank deck, drive the ute from where it is parked | 4 anchors, 22 deck joints, 28 nails; planks landed within 0.1 cm of the deck plane and 2.9 cm of their spots (pass: 2 cm, 5 cm); two floods during the build moved it at most 0.2 cm; the ute crossed the start line 1.5 cm off the bridge's line and reached the far bank, never lower than 0.28 m above the yard |
| The same deck, nails pulled just before the ute sets off                                                                           | Planks shoved up to **361 cm** (the same at the 5 cm and 10 cm voxel sizes: the simulation does not depend on them), the ute does not reach the far bank; nailed, they moved **0.1 cm** (pass: under 3 cm vs over 10 cm)                                                                                           |
| Timber to timber (0.8 stiffness): 300 N at a plank's tip                                                                           | One nail turns 5.06 mrad (load / stiffness predicts 5.16), four nails 1.23 (1.29)                                                                                                                                                                                                                                  |
| Placed setup: beams nailed to both abutments, ute driven across                                                                    | Reaches the far bank; beams moved **2 mm and 3 mm**                                                                                                                                                                                                                                                                |
| 400 N sideways for 1 s after a crossing                                                                                            | Loose beams move **201 mm**, nailed ones **0.2 mm**                                                                                                                                                                                                                                                                |
| Joint stiffness: 300 N sideways at a beam's tip                                                                                    | One nail turns 4.18 mrad (load / stiffness predicts 4.27), four nails 1.05 (1.07); twice the load, about twice the turn                                                                                                                                                                                            |
| Square on                                                                                                                          | 33° holds, 37° is refused                                                                                                                                                                                                                                                                                          |
| Refusals                                                                                                                           | Gap, too thick, not timber, sliding, nothing behind, kinematic, ute, stone that isn't timber, tree, joint full, 64-nail limit                                                                                                                                                                                      |
| Plank nailed to stone and shoved / plank nailed across another and lifted                                                          | Holds / the bottom one comes up with it                                                                                                                                                                                                                                                                            |
| The nailed crossing, run twice                                                                                                     | Identical result                                                                                                                                                                                                                                                                                                   |
| A guest nails online (host + 2 guests)                                                                                             | Host fastens it; both guests get the nail                                                                                                                                                                                                                                                                          |

- Browser test: in the Timber Yard, look at a beam, F nails it and the nail head draws; a second F
  at the same spot is refused.
- Unit tests: 672 pass (both voxel sizes). Browser: the yard, ute, hammer, split screen and all online co-op tests
  pass.

### Audit fixes (second review)

- **Trees are never anchors:** standing trunks and felled stumps in the logging stand were nailable
  stone. Now none of the 90 scenery tree colliders, 6 stand trunks or stumps take an anchor; a
  plank against a stand tree is refused.
- **The gate is inputs only:** no teleports. The player walks to every piece and to the ute, gets in
  by pressing grab at the driver's door, and drives it from where it is parked. The yard is too
  small to swing a ute round (it needs about 4.6 m), so the driver does a three-point turn, backs up
  the bridge's line, then drives over. A plank that lands off its spot now fails the test.
- **Split screen:** each player's nail outline shows in their own half only. Each camera draws its
  own layer, and the browser test checks the pixels: the outline's green appears in player 2's
  half and none in player 1's, with both looking at the same beam.
    - Found on the way: drawn on a layer after the shared Immediate one, lines covered the whole
      screen in split screen, so an outline showed in the wrong half. The per-view layers now sit
      before it.
- **A sawn plank nails down:** the saw cuts the yard's log, and the player takes a plank off the rack,
  carries it and nails it into the ground, by input (see below).
- **Online 8-player steady test** is back at full walking speed, turning: worst guest pose 4.15 cm
  (limit 5 cm).
- **The flood and the gusts (after Epic 8):** the gate now plays through both, by input only.
    - Laying the second beam finishes the crossing and brings the flood. The player waits it out
      in the yard, and before each trip onto the crossing checks that the next flood cannot come
      before they are back.
    - Both floods come during the build (sirens at 42 s and 165 s). The nailed crossing moved at
      most 0.2 cm; nothing was washed away. Loose beams are taken by the same flood (Epic 8's test).
    - When a gust comes for a carried plank, the player holds it low (it catches a fifth of the
      push near the ground), stepping back off the crossing first (over the creek nothing is
      under it). Three gusts came; no plank was lost.
- **Epic 4's bare-beam test now nails the beams:** with the lips, a centred beam leaves a 0.3 m gap
  to the lip at each end, and wheels climbing out of it shove loose bare beams aside. Nailed at
  both ends, two bare beams carry the ute. The yard's bridge is a nailed plank deck anyway. Driving
  onto a beam nailed down nowhere now says so: "Loose beams shift under the ute: nail each beam
  down at both ends to drive across." (conductor-approved design change)
- **A sawn plank, from the log to the nail:** the yard's log goes into the saw, the saw cuts it, and
  the player takes a plank off the rack, carries it to open ground and nails it down, by input.
- **Joint stiffness held to 10%:** one nail turns 5.06 mrad (5.16 predicted) timber to timber, 4.18
  (4.27) into stone; four nails turn about a quarter as much (4.1 times less).
- **Beaver-sized players:** after Epic 9 the eye is 1.22 m up, not 1.86 m. The 35° square-on rule
  stays, so you stand closer to nail; the input tests now step up to each spot. Epic 6's gate test
  needed player 0 parked off player 1's path (they shove each other).

### Found on the way

- **The Epic 4 bridge test's driver steered the wrong way:** its position correction had the
  wrong sign. Fixed. (With the lips added later in this epic, loose bare beams no longer carry the
  ute across: that test now nails them down at both ends; see the audit fixes above.)
- **Two bare 20 cm beams were a marginal road for 24 cm tyres:** a few centimetres decided whether
  the ute got over. That is why the yard bridge is now a plank deck with lips and ramps.

### Next

Stress and calibrated breaking (#49), creaks and safe joint removal (#50).

## Epic 8: the logging sounds and the Valley's waterfall (2026-11-22, #82, #80)

The Timber Yard's logging now sounds as it looks. Before, the sounds existed but nothing played them.

- **Chewing and the axe:** a chop at every bite or blow on a tree (`chop`).
- **The tree comes down:** a heavy, low thud when the felled tree's crown breaks off.
- **The sawmill:** its motor (`saw`, a loop) runs while the blade cuts, rising a little in pitch
  through the cut, and fades out when the planks or the beam come out.
- **Online:** every device works these out from the same snapshots as the chips, needles and
  sawdust, so guests hear them too. Nothing new is sent.
- **Tested:** in the wood-effects test, ten bites give ten chops and the crown gives one thud.
  While a log is sawn the motor is held on every frame (over 60), its pitch rising, and it stops
  being held once the sawmill stops.
- **The Valley's waterfall (#80):** the outfall's water falling into the gorge now roars from
  where it falls. It is the creek's sound, deeper and louder, heard out to about 60 m. The level
  declares where (`valleyLevel.sounds.waterfalls`), from the same numbers as the waterfall piece:
  tested to be within 1 cm of it.
- **Still waiting:** the joint creaks (Epic 5) and the bucket slosh and pour (Epic 7), whose
  mechanics aren't in yet. Their calls are in `docs/sound.md`.

## Epic 7, part 1: the bucket holds real water (2026-11-22)

The bucket now carries water the game keeps track of. Carry it steadily and it stays full. Jerk it, drop it or tip it and water slops out. In the Valley you win by pouring water on the flower, not by setting the bucket down beside it.

### How to play it

- **The HUD** shows the bucket's water under the objective, for example `Bucket ▮▮▮▮▮▮▮▮▮▯ 9.4 L`. On the flower stage it also shows what the flower has had.
- **Carry it gently.** Walking, stopping and turning are fine. A sprint that you stop dead slops some out. So does a drop, a hard hit or a big tilt.
- **Set it down:** click (E, RT, Grab) to let go and the bucket is lowered to the ground first, so it keeps its water. Q (B, Drop) drops it from your hands and it splashes.
- **Pour:** while holding the bucket, press R (Y on a pad, the Pour button on touch). (The River Lab's pad carry-plank toggle moved from Y to d-pad right.) The bucket tips forward, mouth towards where you look. Press again to stop. Letting go also stops it.
- **Refill:** hold or stand the bucket under a water tank's tap. The Timber Yard's tank stands in the south-west corner of the yard; in the Valley there are tanks at the works and on the summit road. It fills at 4 L/s, and says so once when the bucket is full (or a second after you take it away).
    - Each butt holds a fixed amount: the yard's 40 L, the Valley works tank 30 L, the mountain spring butt 20 L.
    - While the level's goal is still open, a butt always keeps at least a bucketful (topping itself up), so the run can't become unwinnable. After the goal it can run dry.
    - Losing the bucket or resetting the props refills every butt.
    - The creek is not a refill point.
- **Timber Yard:** the goal is now the bucket at the flag **with water in it** (at least 0.25 L). An empty bucket gets "The bucket made it, but it is empty", and the level stays open.
- **The Valley:** stages 1–6 are unchanged. Stage 7, Flower Summit, says "Water the flower: hold the bucket inside the ring of stones and pour (R)".
    - At least 0.25 L has to land inside the ring.
    - The stage completes once the pour stops, and says how much the flower drank, with praise for more.
    - The win fires once.
- **A lost bucket:** the spare comes back empty. Its water went into the creek. In the yard the spare reappears on its stump: carry it to the tank to fill it. In the Valley the spares at the works and on the summit road wait under those tanks' taps.

### What was built

- **Volume and slosh (#61, #62), `src/sim/water.ts`:**
    - Litres are kept between 0 and 10 and stepped at 60 Hz.
    - The surface is one plane, driven by a damped oscillator. The force on it is gravity minus the bucket's acceleration. The model uses the bucket's own first slosh frequency, 1.9 Hz when full.
    - Water spills over the low point of the rim when the tilted surface holds less than the bucket has.
    - Hard impacts splash some out.
    - Spinning the bucket dishes the surface. The water picks up the spin slowly.
    - Every input is checked, so there is no NaN and never negative water.
- **In the level, `src/sim/bucket-water.ts`:**
    - Runs on the host, from the bucket's physics body.
    - The water's weight goes onto the bucket (11.5 kg full), updated in 0.5 L steps.
    - Refills come from the level's water sources.
    - Water poured within the flower's radius counts for the flower.
    - It keeps a ledger: bucket + butts + spilled + lost + flower always equals the starting total plus any top-ups, which are recorded. That is how "no duplicate refill" is checked.
- **Pour (#63):** a new action, `ACTION_POUR`. Guests may send it, because it is on the guest whitelist. A wrist torque tips the held bucket 115° forward.
- **Flower goal (#64):** the Valley's last stage has a `flower` target. Tipping the bucket over inside the ring also counts. Water poured after the win still reaches the flower, without a second win.
- **Setting down:** letting go of the bucket lowers it at 1.2 m/s until what is below holds it, then releases it.
- **Online:**
    - Litres and the surface slope ride in the bucket's snapshot animation channels, so every device draws the same water.
    - The host state carries `wat: [litres, flower litres]` for the HUD.
- **Visible water and droplets (#65):**
    - The 1 cm water in the bucket follows the volume and tilts with the surface.
    - When water leaves, blue voxel droplets fall from the rim. When it fills, a stream falls from the tap.
    - The droplets are drawn from a fixed pool of particles and are decoration only. They never decide the volume.
- **Water tanks:** a timber barrel with hoops up on a slim post, over everyone's heads, with a pipe down to an orange tap (`src/levels/water-butt.ts`). The post and the barrel are solid; the pipe and tap are not. The yard's tank stands in its south-west corner, away from the paths to the bridge, the logging stand and the sawmill.
- **Pouring tips the bucket all the way:** the pour turns the bucket's mouth forward and down whichever way it faces, with the wrist sized for turning about the hand.
- **Steadier bucket handling:** a hanging bucket's hand now moves at most 1.5 m/s relative to your eye.
- **Remappable pour (with Epic 10's bindings):** pour is an action in Settings' controls, `pour` in `src/input/bindings.ts`, by default R and the pad's Y. The pad's plank toggle defaults to d-pad right, so Y is free for pour. Binding R to something else takes it off pour, and the prompts and the help line show whatever pour is bound to.
- **Water sounds (with Epic 8's `sfx`):** while water leaves the bucket, the `pour` loop plays at the rim (`sfx.hold`), with a `slosh` as a spill starts (then at most every 0.6 s) and a big splash for a gush. Filling under a tap plays the same loop, rising in pitch as the bucket fills. Each device plays them from the bucket's litres in the snapshots, so guests hear them too.
- **Racing the flood:** with Epic 8's hazards on, finishing the Timber Yard's bridge sets off the flood. Both played yard deliveries (the yard's own, and the sixth bucket after five losses) still cross with the water ahead of the flood, and their tests now check that the siren went off.
    - So a flick of the view swings the bucket round instead of whipping it.
    - Before this, looking up quickly after picking it up flung out 7 of the 10 litres.

### Test results (actual)

| Test                                                               | Result                                                                                                                                                                                 |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Still bucket, 60 s                                                 | 10.00 L, surface level                                                                                                                                                                 |
| Two laps of the yard carrying it (walk, stop, 180° turns in 0.5 s) | **10.00 L** kept                                                                                                                                                                       |
| Timber Yard by the bridge, inputs only                             | 10.00 L over the bridge, 10.00 L after setting it down at the flag                                                                                                                     |
| Tipped 60° and held                                                | keeps exactly what fits under the rim                                                                                                                                                  |
| Dropped at 4 m/s / swung into a wall at 4 m/s                      | 0.63 L / 1.14 L splashed out                                                                                                                                                           |
| In the ute's bed: gentle drive / full throttle then a hard stop    | 10.00 L / 9.27 L                                                                                                                                                                       |
| Pouring                                                            | below 9 L in 0.7 s; empty within 1 s whichever way the bucket faces in the hand (0, 90, 180°)                                                                                          |
| Pour it out and hold it under the yard tap (commands only)         | fills at 4 L/s to exactly 10 L, announced once, then takes nothing more                                                                                                                |
| Five pour-and-refill rounds at the yard butt                       | four from its 40 L, then a recorded top-up: never dry while the goal is open                                                                                                           |
| The Valley's works tank and summit-road butt (commands only)       | each refills an emptied bucket held under its tap to 10 L                                                                                                                              |
| Set down (click) / dropped (Q)                                     | 10.00 L / 0.00 L kept (a beaver's drop lands it on its side)                                                                                                                           |
| Lose five buckets in the creek                                     | each spare is back on the stump, the tank is full again; the sixth is picked up, filled at the tank, carried over the bridge and set down by the flag (commands only): the yard is won |
| Walk into the yard tank's post                                     | stopped against it                                                                                                                                                                     |
| Valley flower, played: carried up the summit road and poured       | arrived with 9.86 L; one win; the same bucket, refilled at the summit tank and poured again, adds water, no second win                                                                 |
| Garbage input (NaN, infinities) for 600 ticks                      | every value finite, volume within 0–10 L                                                                                                                                               |
| Online: a guest picks up and pours the bucket                      | the host drains it; the guest's HUD and own snapshots show the host's litres                                                                                                           |
| Droplets during a 3 s spill and a fill                             | within the particle pool's limit; all gone within a second after it stops                                                                                                              |

- Unit tests: 606 runs pass (every test runs at both the 5 cm and the 10 cm voxel size). The played tests are in `tests/unit/water-play.test.ts`.
- Browser tests pass: the Timber Yard objective and delivery, the Valley stages, online co-op in the Valley (the guest's HUD shows the host's litres), and UI boxes don't overlap.

### Changed on purpose

- **The bucket-throw shortcut in the yard no longer wins.**
    - A full bucket weighs 11.5 kg, too heavy to throw across.
    - If you pour it out and throw the empty one over, it lands at the flag and the level says it is empty.
    - The test now checks exactly that.

### Known limits

- **Q drops the bucket from your hands**: with the beaver's grip it lands on its side and empties (measured 0.00 L left). Click to set it down instead.
- **Hurrying spills.** Carried at a full walk down the yard's bank to the bridge, a full bucket lost about 2.5 L in a test; at half pace, none.
- **Tuned by feel.** The water's damping is set well above real water's so a swinging carry doesn't build up waves. Owner playtesting should set how forgiving it is: the thresholds are in `WATER` in `src/sim/water.ts`.
- **Not tried on a real phone.** The Pour touch button only appears while you hold the bucket.

## Epic 6 follow-ups: beams by hand, felled logs lie still, a determinism check (2026-11-22)

### What changed in the game

- **Sawdust only while the blade is in the wood.** The sawmill kept puffing sawdust after a cut
  while it waited to put the pieces out (when every sawn plank already lies about, it waits until
  some are used). Now the sawdust stops when the cut is done; a test fills the plank pool and checks
  that no sawdust comes while the sawmill waits.
- **A felled log stops where it lands, and still moves when pushed.** A round log on flat
  ground has nothing in the physics to stop it rolling, so a felled log could roll on sideways for
  many seconds after it landed. Now, while it settles from its fall and whenever it lies slow
  (turning slower than 0.5 rad/s and moving slower than 0.3 m/s), it gets strong spin damping:
  bark on the ground. Moved faster than that (shoved, walked into, dropped, thrown) it rolls and
  tumbles as freely as before, then settles again. Carrying is unchanged: a held log has the
  grab's own damping, and letting go restores the log's.
    - **Settling** (a test fells every tree from four sides, 24 fellings, the chewer walking out of
      the way): 22 lie still within 3.6 s of the trunk starting to fall, the fall included. The
      other two lie partly on sloping ground at the stand's edges and creep slowly down it.
      21 of the 24 lie within 0.1 m of the line the toast predicted; the worst is 0.57 m (the
      hard-leaning tree, whose top lands on the bank north of the stand).
    - **Not sticky** (a test against the same log with the lying damping switched off): a 2 m/s
      shove rolls it 5.84 m (5.97 m undamped), and a beaver running into it moves it 0.93 m
      (1.01 m undamped).

### What the tests now prove

- **Beams by player input only:**
    - A beaver walks to the sawmill and pulls its lever: the mill is set to beams.
    - Two beavers fell two trees and carry each whole log into the guide; each comes out as one
      beam (`beam-12`, `beam-13`) and no planks.
    - One beaver shoulders the two sawn beams across the creek as the bridge's stringers. The yard's
      own beams are never touched. (A beaver carries a beam lower than the old person did: low
      enough to catch the creek's warning sign by the bridge, so the route goes north just west
      of it.)
    - The other decks them with three planks from the yard's stack, and a player walks over to the
      far bank without falling in.
- **Determinism of sawing and regrowth:**
    - Every command of a two-beaver run is recorded: fell tree 2, carry the log in, saw it into three
      planks, wait for the stump to regrow.
    - The recording is played into a fresh game with nothing steering it. At five points (felled,
      taken, half sawn, planks out, regrown) the sawmill's state and counts, every tree's state and
      cut, and every object's pose, visibility and animation match exactly.
    - The test also replays the recording with ten ticks of one player's input changed, and checks
      that the result differs, so the comparison does catch a difference.
- **Logs lie flat, back to the 0.2 tolerance:**
    - The old 0.3 allowance was there because the test looked 2 s after the fall, while the log
      could still be sliding its foot off the stump.
    - The tests now wait until the log is still (the chewer walking out of its way first), then
      check that it lies within 0.2 of flat and that its foot is on the ground, not up on the
      stump. This is checked for the chewing test and for all eight sides of the fall-direction
      test. No log was left resting on its stump, so no "kick off the stump" was needed.
    - Worst measured: 0.073 (about 4°), the hard-leaning tree whose top rests on the bank; the
      other seven are at most 0.03. Every foot lies on the ground, within 3 mm.

## Epic 8, part 2: the handbrake prank, and sound for the other epics (2026-11-22)

- **The handbrake prank (#75):**
    - **When:** the ute is left parked on a slope (3.5° or more) with nobody in it for 6 s.
    - **The tell:** a ratchet clicks, and a toast says "Get in and hold the brake, or chock a
      downhill wheel".
    - **What happens:** 2.5 s later the handbrake lets go and the ute rolls, for up to 20 s or until
      someone takes the driver's seat. Tested by driving the ute up the far bank's road (about 10°),
      braking, getting out: it rolls more than 3 m back down towards the creek.
    - **Counterplay, each tested:**
        - park on the flat (the yard: nothing happens);
        - get in at the warning: look at the door and grab, as a player does (the ute stays within
          0.5 m);
        - chock a downhill wheel: the cube against the front wheel, or a beam on its edge across the
          front tyres, holds it (asserted under 5 cm in 5 s with the handbrake off; measured 0 mm),
          against more than 3 m unchocked. A plank lying flat (0.1 m) is a step the wheel climbs: no
          chock. Chocks are a rule, not physics: the wheels are rays that would roll over a prop, so
          the game checks for one standing at least 0.13 m high from under a tyre's centre to 0.4 m
          past its downhill face (out to the bumper), and while it stands there the brake stays on.
          Pull the chock out during the prank and the ute rolls (tested: more than 3 m in 4 s).
    - **Fixed on the way (an Epic 4 bug):** a parked ute with its handbrake on crept down a slope,
      2.5 cm a second on the far bank's road, because the wheel brake is a capped friction impulse
      that gravity wins back a little of every tick. Now a parked ute that is nearly still and
      standing on its wheels on fixed ground is held where it stands, gravity off while it holds,
      until something moves it faster than 0.1 m/s. Any sideways push lets go of it for half a
      second, so players can still shove a parked ute against its brake as before. Tested: parked
      on that slope for 30 s it moves under 2 cm (measured 0 mm); two beavers pushing it on the flat
      move it (measured 4.9 m in 3 s) and it holds again when they stop; a slow steady push of
      3.5 m/s² still moves it (measured 5 cm in 2 s, where a lock that swallowed it gave 0). The ute's driving, braking, deck and platform tests pass unchanged;
      on a deck or beam that can move it rides along as before.
    - **Recovery:** if it ends up in the creek, the ute's usual recovery applies.
    - **Budget, tested:** one hazard at a time (no flood or gust during a prank, and no prank during
      a flood or a gust, each then waiting out the 15 s quiet), at most 2 pranks, 60 s apart.
    - **Online, tested:** the guest gets the toast and the brake phase, and sees the ute roll in the
      host's snapshots (within 5 cm of the host's).
    - #75 can close except for tying it off (there are no ropes yet).
- **Sound for the other epics (`docs/sound.md`):**
    - **New sounds:** a sawmill motor (`saw`, a loop), `chop`, `slosh`, pouring water (`pour`, a loop)
      and the handbrake's `ratchet`.
    - **New call:** `sfx.hold(key, name, position)` keeps a loop playing for as long as a feature
      calls it each frame, such as a sawmill running or water pouring. A quarter of a second after
      the calls stop it fades out (under a second), then it is stopped and removed (tested).
    - Epic 5 (creaks, breaks), Epic 6 (sawmill, chopping) and Epic 7 (slosh, pour) each have a line
      to copy.
- **Playtest kit:** the log's summary also counts handbrake pranks (tested with a real prank fed in
  as the game feeds it), and the script says what to watch for and how the prank works.
- **Tests:** unit tests pass at both voxel sizes, on top of `epics-5-10` (67cdc30, with Epic 9
  part 2). New:
    - the prank: driven onto the slope and parked, a braked ute holding for 30 s, the flat yard,
      getting in at the warning, the cube and the beam chocks, the flat plank that isn't one, the budget, one hazard at a time
      both ways round, and online;
    - `sfx.hold`'s fade, stop and removal;
    - the playtest log counting a real prank.

## Side paths in the Valley (2026-11-22, Epic 9, towards #87)

Two tracks now leave the Forest Road. Neither goes near a crossing: the Epic 5 session is
reworking those into built bridges. Detours around the crossings themselves (the rest of #87) wait
for the owner's call.

- **The old logging track** leaves the road at 11 m past the creek crossing and rejoins it at
  35.5 m, before the culvert.
    - It is a 32.7 m loop through the forest on the far side of the log dump.
    - It is wide enough for the ute, and clear of trees and scenery.
    - It gives a road closure (an Epic 8 hazard) somewhere to send you.
- **The lookout track** climbs 1.8 m over 18.7 m, from just past the culvert flag to the foot of
  the fire lookout. It stops short of the lookout's legs.
- **How they're made** (`src/levels/side-paths.ts`, with the paths listed in `valley.ts`
  `SIDE_PATHS`):
    - the ground is graded level across each track, following its centre line's own height;
    - the valley-side terraces are left off them;
    - they are painted as a dirt track with a few dry tufts;
    - trees and flowers are kept off.
- **Tests** (`tests/unit/side-paths.test.ts`):
    - walking each centre line in 25 cm steps, no step rises more than 10 cm (the beaver steps
      up 32 cm);
    - level across, measured square to each stretch of track: within 6 cm over 1.2 m, and at
      most half the ground's own cross-fall there (nil along the stretches, 0.4 at worst where
      two stretches meet). The test fails with the grading off;
    - a beaver walks each track end to end by input, at walking speed, never further than 30 cm
      from its edge;
    - in the Valley sim, a player drives the ute round the logging loop end to end, every wheel
      within the track. The ground there is gentle enough to drive without the grading; what this
      shows is that the ute fits and nothing is in its way;
    - the logging track starts and ends on the road, and the lookout track ends at the lookout's
      foot, clear of its legs;
    - no tree within 2 m, and no static piece, on either track.
- Also new, for the route signs:
    - each sign's arrow is checked against the road as it is painted, found from the ground's
      surface material rather than the road formula. The works' sign is the exception: its
      concrete road can't be told from the concrete yard by surface alone.
    - a left arrow is read back from the voxels too.
- Unit tests: 516 pass (merged with Epics 6, 8, 9 part 1 and 10, and the controls remapping).

## Valley performance: what costs what, and Low builds less (2026-11-22, Epic 9, owner question)

The owner asked: could the Valley load only the current area, with a cut between areas? The
world already culls by chunk, but there is no occlusion culling. Measured first.

### What the Valley draws (one-off, in the browser)

Measured by hand in the container's software renderer, with the Inspector's devtools hook
(`globalThis.__playcanvasApps`): teleport to the spot, wait for the tiles to stop streaming, then
read `app.stats.drawCalls.total` with each lattice's root on or off. Draw calls are counted the
same way on any GPU; frame times there are not representative.

- **The near world** (the 5 cm tiles around you) is most of the cost: 1,500–1,900 draw calls at
  36 m.
- **The far lattice** (the whole map at 40 cm) is about 700 meshes and 0.72 M triangles wherever
  you are.
    - Hiding all of it saves 20–500 draw calls. The most is at the yard looking up the valley
      (28%); the least is at the summit.
- **An area cut on the far lattice** (draw only the current area and its neighbours) saves 10–25%
  of draw calls.
    - It would also hide the distant landmarks, the summit flower above all. Seeing your goal on
      the far ridge from the start is in the design doc.

So a cut between areas buys little, and it costs the view.

### What changed

The near world's radius is the lever, so it now follows the quality preset
(`src/levels/view-distance.ts`).

- **High:** 36 m, as before.
- **Low:** 24 m. The fog starts at 18 m instead of 30 m. It is light there (linear to 260 m, a few
  percent at 24 m), so on Low the coarse far lattice can be seen beyond 24 m: that is the trade.
- **The far lattice is not affected**, so the landmarks and the summit flower show on Low as on
  High. A test builds the far lattice at 40 cm, gives it the Low radius, and finds the lookout,
  the mast and the flower in it. The flower's stem and leaf were thickened so every part survives
  40 cm cells.

The bench (`tests/unit/view-distance.test.ts`, "bench"; reproducible, run with `npm test`) settles
the near world at a fixed camera on each preset. Meshes are what the renderer draws, one per
surface class of each static unit (draw calls for one camera pass, before culling):

| Bench, 5 cm voxels     | 36 m (High)    | 24 m (Low)    |
| ---------------------- | -------------- | ------------- |
| Tiles (forest / works) | 131 / 119      | 65 / 57       |
| Static cells           | 12.8 M / 8.0 M | 6.1 M / 3.0 M |
| Meshes                 | 430 / 387      | 203 / 181     |
| Triangles              | 5.0 M / 2.8 M  | 2.2 M / 0.9 M |

At 10 cm voxels: meshes 422 / 389 → 197 / 182, triangles 1.5 M / 1.1 M → 0.7 M / 0.4 M.

Measured once by hand in the browser (method above), the JS heap went from 525 / 343 MB to
317 / 173 MB, and drawn calls from 1,920 / 1,520 to 1,323 / 974.

- **Switching preset takes effect at once.** The radius goes to the voxel worker with each frame.
- **Tiles behind you** are kept up to 1.35 × the radius (was radius + 12.8 m). High is about the
  same (48.6 m). On Low, tiles really are let go.

### Not done, and why

- **Occlusion culling:** the Valley's sides and the gorge walls hide a lot, but terrain-based
  occlusion is real work for a smaller win than the radius.
- **Phones still start on High:** every device does. Making Low the default on phones is an easy
  next step if the owner wants it.

### Tests

- The bench above, asserting Low builds under 60% of High's tiles, meshes and triangles.
- The radius wiring, end to end:
    - the preset gives the radius and fog start;
    - the voxel client sends the radius with each frame to the near world lane only (not the far
      lattice or object lanes);
    - the real worker module, driven frame by frame, builds out to 24 m on Low and past it on High.
- A Valley test: after switching to Low no tile is left beyond 1.35 × 24 m, and the ground under
  you is always built.

## Remappable controls (2026-11-22, Epic 10)

You can now choose your own keys, mouse buttons and gamepad buttons. Settings has two new
sections: **Keys** and **Pad**.

### How to use it

- Open Settings (Esc, the ⚙ button, or Start on a pad), go to **Keys** or **Pad**.
- Each action has two slots. Press a slot, then the key, mouse button, wheel turn or pad button you
  want there.
    - **Esc** cancels (Start on a pad). **Backspace** or **Delete** empties the slot.
    - A key does one thing: put W on Jump and it comes off Move forward. The menu says so ("W was
      Move forward: that is now unbound there").
- **Reset keys to defaults** and **Reset gamepad buttons to defaults** put each set back.
  **Reset all settings** (Interface) resets them too.
- Saved per browser (only what you changed), so a later change to the defaults still reaches you.
- The control hints and prompts follow your keys: the hint reads "F jump" with jump on F, and the
  prompt reads "E to grab …" with grab on E.

### What can be remapped

- **Keys:** move (4 directions), run, jump, grab / release / use, throw, drop, ragdoll, carry
  plank, and hold further / closer.
- **Pad:** the same, except moving and looking, which stay on the sticks. Their speed and
  inversion are settings.
- **Not remappable**, so you can always get back to the menu: Esc, Start, F3 (debug panel) and Tab.
- A key bound to an action wins over the game's own hotkeys (V, P, C, L, H): bind V to jump and V
  jumps. The hint then stops offering "V orbit".
- Keys are by position on the keyboard (`KeyboardEvent.code`), so the defaults sit in the same
  place on AZERTY or Dvorak keyboards.

### Tests (actual)

- Unit (`tests/unit/bindings.test.ts`, both voxel sizes):
    - every default key and button does exactly one thing;
    - rebinding takes a key off its old action and names it;
    - Esc, F3, Tab and Start can't be bound;
    - saving stores only changes and loads back exactly;
    - junk, unknown actions, prototype keys and duplicate keys in storage are cleaned up;
    - a remapped pad button does the action and its old button no longer does.
- Browser test, rebinding in Settings:
    - Jump goes to F, and W goes onto Jump (taken off Move forward, and the menu says so);
    - Esc cancels a capture, Backspace clears a slot;
    - a pad press puts X on the pad's Jump (taken off the ragdoll).
    - In the game, F jumps and Space no longer does. The hint reads "F jump".
    - After a reload both are still there, and Reset puts the keys back.
- Unit (`tests/unit/prompts.test.ts`): prompts read as before with the defaults. They name a rebound
  key or button the moment it changes ("R to grab the bucket", "RB to grab", "ZASD"). The axe
  prompt says the rebound grab and drop ("F to chop the pine · X to put the axe down"). A hotkey's
  hint disappears while its key is bound to an action.
- Browser test, continued: V bound to Jump jumps and stays in first person, and the hint drops
  "V orbit". Reset keys, Reset gamepad buttons and Reset all settings each clear what they cover.
- UI layout test: now also at 360 × 740. With the Keys section open, nothing in it sticks out of
  the dialog, and the current section tab is fully in view (also after switching to Interface and
  back to Game).
- The settings, UI-layout, first-person, Timber Yard, ute, split-screen and logging browser tests
  pass.

### Known limits

- **On a phone the six Settings sections don't all fit:** the section row scrolls sideways and
  keeps the current section in view.
- **Touch controls aren't remappable.** The on-screen buttons stay where they are.
- **A pad joins with A**, whatever A is bound to (the joining press is not also an action).
- **Analogue triggers count from part way down** (40 %). Bound to an action, they press it like a
  button.

## Epic 8: the world fights back, sound, and a playtest kit (2026-11-22)

The Timber Yard is now a complete slice: the creek floods when you finish the bridge, the wind
goes for the plank you carry, everything makes a sound, and there is a script and an in-game log
for running the playtest gate.

### The hazards (#18, #71–#73)

The world answers your progress on purpose. The hazard director runs inside the host's
simulation, so it is deterministic, and guests see exactly what the host sees.

- **A seed per game:** the host picks one each visit (`?seed=` replays one) and sends it to guests.
- **What it varies:** the siren's delay (3–5 s), how long a carry takes to bring a gust (1.5–2.5 s),
  and the gust's direction (straight across the creek, or slanting up- or downstream).
- **Tested:** the same seed and inputs give the same floods, gusts and world. Four different seeds
  gave four different sets of hazards.

- **The creek floods when the bridge is finished (#72):**
    - **When:** the bridge is finished, meaning two pieces lie across the gap, still and let go (or
      one piece left across for 20 s). The siren comes 4–6 s later.
    - **The tell:** a siren, a rumble, and the new banded gauge post by the crossing going under.
      The toast says what to do.
    - **What happens:** the water rises from −0.45 m to 0.60 m, just over the capstones, over 18 s.
      It stays up for 14 s and falls over 12 s. Floodwater floats timber and runs downstream at 1.3 m/s.
    - **Nothing is lost for good:** whatever it carried off is left on the near bank downstream when
      the water is down.
    - **Normal play isn't punished:** the bridge-building playthrough walks back to the stump for
      the bucket and carries it over at a normal walk, with no sprint. It crosses 14 s after the
      bridge is finished (14.1 s, with the beaver body), with the water still at −0.11 m, 0.61 m below
      the capstones. The test asserts at least 0.5 m.
    - **Counterplay, all tested:**
        - carry the bucket across before the water rises;
        - stand on the beams, one player on each;
        - hold the beams.
          Left alone, both beams wash away.
    - **Still winnable after a washout (tested with player inputs only):** walk to both beams on
      the bank downstream, carry them back, lay the bridge again and walk the bucket over.
- **A gust goes for the plank you carry (#73):**
    - **When:** after 1.5–2.5 s (from the seed) of carrying a plank within 4 m of the creek. It goes
      only for planks, never the bucket, a crate or a shouldered beam.
    - **The tell:** the windsock swings round and stands out, a stream of leaves blows past, a
      warning gust sounds, and a toast warns.
    - **What happens:** 2.2 s later, a 2 s gust pushes the plank towards the creek with 1,050 N, more
      than one grip (650 N). It tears the plank out of your hands, and it lands in the creek
      by the bank.
    - **Counterplay, all tested:**
        - hold it low (look down): it catches only about half the gust, measured 563 N, and you
          keep it;
        - carry it with a friend: two grips give 1,300 N;
        - put it down: things lying still are left alone.
- **Budget (#71), each rule tested over long runs:**
    - one hazard at a time, and 15 s of quiet after each;
    - nothing in the first 20 s of a run, and nothing after the goal;
    - at most 2 floods, the second at least 75 s after the first ends, and none once the bucket is
      across (six minutes of rebuilding brought exactly two);
    - at most 3 gusts, 40 s apart (four minutes of carrying brought exactly three), and only while
      3 or more planks are still out of the creek.
- **Screenshots:** the crossing with the bridge just laid
  (`docs/screenshots/epic8/01-flood-before.jpg`), and the same view at the flood's peak, with the
  loose beams afloat (`02-flood-peak.jpg`).
- **Online:** the host sends the water level, the hazard phases and the seed with its state.
  Guests run no hazards of their own.
    - **Unit tests, through real host and guest sessions:**
        - a flood reaches the guest: the seed, the siren toast, the phases, and the water height,
          within 2 mm of the host's;
        - a gust reaches the guest: its phase, target and direction.
    - **The guest's windsock:** a guest never runs its own simulation, so its windsock comes from the
      host's snapshots. During the gust warning it points within 0.02 rad of the host's, downwind
      into the gust (tested).
    - **Browser test, two pages over the local transport:** the host finishes the bridge, and on
      the guest's screen the river rises, the siren toast shows and the siren plays.

### Sound (#19, #79–#82)

- **Every sound is made in code:** 33 of them, generated when the game starts. They are original,
  so there is nothing to license or credit, and nothing to download.
- **Starts on your first click, tap or key:** browsers and the itch.io embed only allow sound
  after one. Before that, the game doesn't even create the audio system, so the console stays clean.
- **What you hear:**
    - **Impacts:** wooden knocks, the bucket's clank, heavy thuds, louder for harder hits.
    - **Water:** splashes, small and big, including you falling in.
    - **Your hands and feet:** grabs, throws and footsteps.
    - **The ute:** its engine follows the speed, and the doors clunk as you get in and out.
    - **Ambience:** the creek (louder in flood), wind that follows the gusts, and birds.
    - **Hazard tells:** the siren and the flood's rumble, the warning gust and the gust.
    - **Progress:** a ding for each step and a fanfare at the goal.
- **Sound tab in Settings:** Volume, Effects and Ambience, saved like the other settings.
  `?sound=off` mutes for one visit. Music and Voice sliders come when there is music or voice to
  play, so #79 stays open for those.
- **For Epic 5 (bridges):** `sfx.creak(position, strain)` and `sfx.snap(position)` in
  `src/audio/sfx.ts`. Creaks are louder and deeper as strain goes up, and calls before the sound has
  started do nothing.
- **Not done:** music and beaver chatter (#83). The settings have no music or voice slider until
  there is something to play.

### The playtest kit (#70)

- **`docs/playtest.md`** is the script for the gate: the words to say, what not to say, what to
  watch for, the questions to ask afterwards, a pass/fail table, and a template for recording the
  results here.
- **Settings → Game → Playtest log…** records the session on the device:
    - every event (falls, recoveries, stages, the goal, each hazard and what it did, the ute);
    - grabs, restarts, menu visits and who joins;
    - every 5 s, where the players and the bucket are, what they hold and the water level.
- **The summary at the top answers the gate's questions:** how long, finished or not, how many
  falls, and floods and gusts met. Add notes as you watch, then copy or save it as a file. The
  previous session's log is kept too.
- **Not done:** the playtests themselves (solo, a team of two, an unfamiliar tester). They need
  people, so #70 stays open.

### Tests

- Unit tests: 382 pass (was 326), at both voxel sizes. New: `hazards.test.ts` (flood, gust,
  budget, seed, online, rebuild after a washout), `audio.test.ts` and `playtest.test.ts`.
- New browser tests:
    - a finished bridge in the Timber Yard brings the flood and its siren, the drawn river rises
      with it, the sound starts only after a key press, and the playtest log records it;
    - over the local transport, the host's flood reaches the guest: its river, toast and siren.

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
    - Getting onto the laid beams can take about 5 s, with either body. Their near ends rest 10 cm
      past the edge of the abutment's stone cap. That leaves a 10 cm ledge, narrower than the
      character controller's 12 cm minimum step width, so the cap (10 cm up) and the beams (20 cm
      up) can't be stepped one after the other, and you crawl up.
    - Measured: laid 10 cm further out, the slow part drops from 5.4 s to 0.9 s. Epic 5's approach
      ramps can remove it.
    - The test's walk allows for it (1,800 ticks instead of 900).
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

| Test                                                                                              | Result                                                                                                                     |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Join and walk; three one-frame jump presses                                                       | Exactly 3 jumps on the host                                                                                                |
| Host and guest lift the 113 kg log together                                                       | Both hold it, it rises over 0.4 m; the guest's one release press lets go                                                   |
| Garbage input (NaN, 1e300, strings, reset requests)                                               | Every position stays finite, no reset or drop test runs, lag reads "unknown"                                               |
| A guest drops, reloads, comes back                                                                | Same player, within 0.3 m of where it stood; a newcomer meanwhile got a different place                                    |
| A guest drops while carrying the bucket                                                           | The bucket is let go at once; the place frees after the grace period                                                       |
| 8 players walking and turning (after Epic 5's audit: full speed round a 1.5 m circle on the flat) | All 8 move; what each guest draws (every player, the bucket) matches the host to 4.15 cm, worst of 567 checks (bound 5 cm) |
| A jump across 20 Hz snapshots (its own test since Epic 5's audit)                                 | 4.37 cm with every update (bound 5.96 cm), 8.36 cm with one update lost (bound 12.1 cm)                                    |
| A host that goes quiet, then comes back                                                           | "Reconnecting", then reconnected and receiving again; gone for good, the guest gives up after 20 s                         |
| A guest of a build with other entities                                                            | Applies no snapshot and says it's another version                                                                          |
| Largest host state: the Valley, 8 players, every entity drawn, long events                        | 2,841 bytes (the room allows 4,096)                                                                                        |

Across a jump's take-off or landing, the guest draws the straight line between 20 Hz snapshots:
that is the jump row's error, against its derived bound dv·T/4 + g·T²/8 + 4 mm. The codec itself is
good to 4 mm. (This entry first said 2.8 cm for walking and jumping together; Epic 5's audit split
them.)

Host cost per tick with everyone walking (`node scripts/bench-net-host.ts`, Node on this container's
CPU; the budget is 16.7 ms). The host's published state peaked at 1,875–1,896 bytes in the Valley at 8 (two runs).

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

| Test                                                                    | Result                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parked on a free platform                                               | All 4 wheels on it; reaction / weight = **1.000**; the platform stays pressed onto the ground                                                                                                                                         |
| Accelerating on a free platform on ice                                  | The platform is pushed backwards (momentum is shared)                                                                                                                                                                                 |
| A loose deck over a gap                                                 | Carries the ute and stays on its supports                                                                                                                                                                                             |
| Two loose 20 cm beams over the Timber Yard creek (before Epic 5's lips) | Both took its weight out to mid-gap (over 0.3 × weight) and stayed across. Now, with the lips: loose, they are shoved aside and the ute stops at mid-gap (z -1.99); nailed at both ends, it reaches the far bank and they move 2–3 mm |
| Top speed and braking                                                   | 8.5 m/s after 6 s; stops in 1.2 s                                                                                                                                                                                                     |
| A ~30 kg crate in the bed, after a 3 s run and a hard stop              | Still in the bed: it slid forward to the cab end under braking                                                                                                                                                                        |
| Rolled onto its roof                                                    | Back on its wheels in 1.05 s                                                                                                                                                                                                          |
| Dropped nose-down in the creek, driver presses drop                     | Back at its safe spot, upright, driver still seated                                                                                                                                                                                   |

- Browser test: get in, drive with the keyboard, get out, in the Timber Yard.
- Unit tests: 326 pass.

### Known limits

- **Crossing loose 20 cm beams all the way:** past mid-gap, the tyres' sideways push walks an unfastened beam out from under a wheel. Fastening comes in Epic 5. (Done there: nailed at both ends, two bare beams carry the ute across, and driving onto loose ones says to nail them.)
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
