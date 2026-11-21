# ADR 0012 — Online co-op outside claude.ai: WebRTC peer to peer, signalled over Nostr

Status: accepted (owner request, 2026-11-21: "I should be able to do multiplayer from itch.io") ·
Date: 2026-11-21 · Amends: ADR 0010

## Context

Online co-op (ADR 0010) runs over the claude.ai artifact `room`, which only exists inside
claude.ai. The game is also released to itch.io (`docs/releasing.md`), where it could only be played
solo or in local split screen. The design doc's long-term answer is a game server of ours, but we
have none, and nothing to host one on.

## Decision

- **A new transport, `P2PTransport` (`src/net/p2p.ts`)**, with the same presence semantics as the
  room. The sessions, codec and lobby (ADR 0010) are unchanged.
    - Each participant keeps one JSON state.
    - Everyone in a room sees everyone's latest state.
    - A state disappears when its peer leaves.
- **WebRTC data channels between the players' browsers**, set up with
  [Trystero](https://github.com/dmotz/trystero) 0.26.0 over **public Nostr relays**.
    - The relays only carry the connection handshake (a few small, short-lived events). Snapshots
      and input go browser to browser.
    - There is no server, account or key of ours. Trystero's default STUN servers (Google,
      Cloudflare) find each player's public address.
    - The app id `uncivil-engineers.v1` keeps our rooms apart from other apps on the same relays.
- **States are sent whole**: on every change (coalesced to ~30 Hz, like the room) and to each newly
  connected peer. Received states must be plain objects of at most 16 KiB; ADR 0010's validation
  of every field still applies.
- **Which transport:**
    - `?net=local` → BroadcastChannel (tests).
    - On claude.ai → the room, as before.
    - Elsewhere → peer to peer.
    - `?net=p2p` forces peer to peer and `?net=off` disables online play.
- **The P2P lobby connects lazily**, when "Play online" is first opened (or with `?join=`). Every
  itch.io visitor would otherwise join the public lobby and open WebRTC connections on page load.
  The code is a separate 27 KB (gzipped) chunk, loaded only then.
- **Tests:** the online browser test runs twice: over BroadcastChannel, and over WebRTC between two
  pages signalled through a minimal in-process Nostr relay (`tests/e2e/nostr-relay.ts`).
  `?relays=` replaces the public relays and `?ice=local` drops the STUN servers.

## Consequences

- **Online co-op works on itch.io**: open "Play online", host, and friends anywhere join from the
  list. The game is only listed while the host has the page open.
- **No TURN server.** If both players are behind strict NATs (some mobile carriers, some
  corporate or school networks), the direct connection fails. A guest on such a network sees the
  game in the list but never receives a snapshot. How often this happens is unmeasured here.
  A TURN service (paid, or self-hosted) would fix it via `turnConfig`.
- **Relies on public relays** we don't run. Trystero uses five at a time from a list of about
  thirty, so a few being down is fine.
- **The lobby is a full mesh** of everyone with the panel open. That is fine for tens of players,
  not for hundreds. If it grows, advertise games on the relays directly instead of in a lobby room.
- **Host IPs are visible** to the other players, as in any peer-to-peer game.
- **Untested here against the real relays:** the development container cannot reach them.
  Signalling, connection, hosting, joining, play and leaving were tested end to end against the
  local relay.

## Update (2026-11-21, after the owner's first try: "It never showed up")

- **Measured against the real public relays**, with two browser profiles on one machine. The
  relays worked: both pages found each other and exchanged offers within seconds.
    - The direct connection then failed for minutes ("could not connect to peer after exchanging
      SDP"). Neither device could resolve the other's mDNS-hidden local address, and no other route
      existed.
    - With local addresses exposed, it connected first time.
    - This is the same failure as two devices on one Wi-Fi whose router filters mDNS and can't loop
      traffic back through its public address.
- **Relays:** Trystero's own pick for our app id was five small relays; one was on port 8443, which
  some networks block. We now use ten relays together, all on port 443: the four of those five that
  answered, plus six large public relays.
- **TURN support:** an optional relay for game data. It is built in from the repository secrets
  `TURN_URLS`, `TURN_USERNAME` and `TURN_CREDENTIAL` (`docs/releasing.md`).
- **The panel shows the connection state:** relays connected, players connected, and a plain
  message when a direct connection fails.
- Turning off trickle ICE made connections worse, so it stays on.
