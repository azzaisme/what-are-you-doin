# ADR 0010 — Online co-op over the artifact room (host-authoritative, presence only)

Status: accepted (owner request: let two people join on their phones) · Date: 2026-11-20

## Context
The demo is hosted as a claude.ai artifact; there is no game server of ours. The design doc's
multiplayer model (§6.2) is a server that owns physics and receives sequenced commands, with
clients interpolating snapshots and synthesizing voxels locally. The artifact runtime offers a
`room` capability: everyone with the page open, a per-participant presence object (JSON, 4 KiB,
coalesced ~30 Hz, settable by every admitted viewer, cleared on leave) and named rooms.

## Decision
- **Host-authoritative listen server.** One player's device ("Host a game") runs the only
  simulation, exactly the offline one: physics, grabs, rules, events. Guests run no physics.
- **Presence only, no event topics.** Guests publish `{role: 'guest', in: …}`: absolute input
  (move, sprint, look) plus **counters** for jumps, grabs, throws and actions, so a coalesced or
  dropped update never loses or repeats a press. The host publishes `{role: 'host', slots, s, hud,
  goal, ev}`: a binary snapshot every 3 ticks (20 Hz) as base64 chunks of ≤ 1,000 characters,
  each player's held/targeted ids for their prompts, the objective and the last three events.
  Presence is settable by any admitted viewer, so no topic permissions are needed (topics would be
  admin-only or need Contributor access).
- **Snapshot codec** (`src/net/codec.ts`): per visible entity 15 bytes (index, flags, 2 mm
  positions, smallest-three quaternion) plus animation channels at 1/500 with angle unwrapping.
  The yard with two players is ~600 bytes. Guests write snapshots into their existing snapshot
  ring at the host's tick numbers, so the existing interpolation and the voxel worker do the rest;
  every device rebuilds its own voxels (§4.2: no cells on the network).
- **Guest clock:** a smoothed host-tick estimate, rendered 9 ticks (150 ms) behind the newest
  snapshot, never extrapolated past it. No client-side prediction yet: a guest's own movement shows
  after one round trip plus 150 ms; look is local and immediate.
- **Discovery:** the host advertises `{game: {code, level, players, max}}` in the lobby presence;
  each game is a named room `ue-<code>`. Up to 4 players share the slots with local split screen.
- **Validation:** every guest field is type-checked and the command sanitized; guests may only
  request drop and ragdoll actions (no resets or drop tests). Peer ids come from the platform and
  cannot be forged; a guest's slot is assigned by the host.
- **Transports:** `RoomTransport` (published page), `LocalTransport` (BroadcastChannel between tabs,
  `?net=local`, used by the browser test), `MemoryHub` (unit tests).
- **Touch controls** for phones: floating left stick (edge = run), right-half drag to look, four
  64 px buttons.

## Consequences
- People must be **signed in and invited** to the artifact (Share menu); visitors by public link
  cannot connect to rooms.
- The host must keep the page open and in front: a backgrounded host pauses the game for everyone
  (browsers stop frame callbacks in hidden tabs). If the host leaves, guests return to a solo world.
- Latency is unmeasured on real networks; snapshot rate and the 150 ms delay may need tuning, and
  guest movement prediction is the obvious next step.
- No reconnect or host migration; the presence budget (~40 messages/s, 4 KiB) bounds snapshot size
  (enough for ~200 visible bodies).
