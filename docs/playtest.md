# Playtest script: the Timber Yard vertical slice (Epic 8 gate)

The gate for Epic 8 (issues #15 and #70):

- one player, and then a team of two, finish a 5–15 minute session **without help**;
- afterwards they can say **why** each failure happened, and name **another way** they could have
  done it;
- the same again with **someone who has never seen the game**;
- the world **fights back on purpose** (the flood and the gust), not only through physics accidents.

This page is everything you need to run it. Plan on 30 minutes per session, including the talk
afterwards.

## Before the session

1. Use the itch.io build (or `npm run build && npm run start`). Sound on, at a normal volume.
2. Open **Levels → Timber Yard (on its own)**.
3. Check the log is fresh: **Settings → Game → Playtest log…**. It starts when the page loads, so
   reload the page just before the tester starts. The last session's log stays under **Previous
   session**, in case you forgot to save it.
4. For the team of two, set up one of these:
    - **Online:** **Play online** on two devices. The host makes the game and the guest joins it.
    - **One screen:** split screen with a gamepad for the second player.
5. Do not show the tester the controls, the creek or the bridge. The tutorial is theirs to play
   only if they ask for it.

## What to say (read it out, word for word)

> This is a game about getting a bucket across a creek. Do whatever you think will work. I can't
> help you while you play, but you can think aloud if you like. Tell me when you think you're done,
> or if you want to stop. You have up to fifteen minutes.

Then start a timer and stay quiet.

## While they play

- **Don't help.** Not with the controls, the bridge or the hazards. If they ask, say "do what you
  think". Answer only real breakdowns, such as a crash, a frozen screen or a lost connection. Write
  those down, because they mean the session doesn't count.
- **Take notes in the game:** **Settings → Game → Playtest log…**, type what you saw and press
  **Add note**. Each note gets the time, next to everything the game recorded. Solo play pauses
  while the menu is open, so do this at a natural break, or keep notes on paper and add them
  afterwards.
- **Watch for these moments:**
    - **The first minute:** do they find out how to move, look and grab without help?
    - **The plan:** do they build a bridge, throw the bucket over, or try something else?
    - **The flood** (when the bridge is finished): do they notice the siren, the rumble and
      the gauge post's marks going under? What do they do? Run with the bucket, stand on the beams,
      hold them, or watch?
    - **The gust** (when carrying a plank near the creek): do they notice the windsock swing round and
      the warning? Do they lower the plank, call their teammate over, put it down, or get it blown in?
    - **The ute** (if they park it on a slope): do they hear the ratchet and read the warning? Do
      they run to get in, or wedge something against a wheel?
    - **The falling tree** (if they cut a stand tree with the ute close by): do they hear the
      crack, see the tree lean and read the warning? Do they move the ute, go round to cut from its side, or carry on?
    - **The road closure** (the Valley, coming up the forest road): do they hear the clunk and read
      the sign? Do they take the old logging track, shift the barrier, or squeeze past it on foot (and what about the ute)?
    - **Every fall into the creek:** what were they trying to do?
    - **Stuck:** a minute or more with no progress. Note what they are trying.

## Afterwards (5–10 minutes)

Ask these in order, and write down the answers as they say them.

1. "How did it go?" (let them talk)
2. For each failure you saw (a fall, the bridge washed away, a plank blown in): "What happened
   there? Why?"
3. "What else could you have done?"
4. "Did the game ever feel like it was out to get you? When? Was that fair?"
5. "Could you tell what the siren and the wind were warning you about?"
6. "Was anything confusing, or annoying? How was the sound?"

Then save the log: **Settings → Game → Playtest log… → Save as file** (or **Copy**, and paste it
somewhere).

## Pass or fail

| Question                             | Pass when                                                                           |
| ------------------------------------ | ----------------------------------------------------------------------------------- |
| Finished unaided in 5–15 minutes?    | The log's summary says "finished: yes" between 5:00 and 15:00, and you gave no help |
| Can explain each failure?            | For each failure you asked about, they gave a cause that matches what happened      |
| Can find other solutions?            | They named at least one way that would have worked                                  |
| Did the world fight back on purpose? | At least one flood or gust happened (in the log), and they noticed its warning      |

A session that took less than 5 minutes passes on everything else, but note how long it took: the
slice may be too short.

## What the game does (for you, not the tester)

- **The flood:** the siren goes 4–6 s after the bridge is finished, meaning two pieces lie across
  the gap and are let go, or one piece is left across for 20 s. It never comes in the first 20 s of
  a run or once the bucket is across, and comes at most twice. A player who walks back for the
  bucket at a normal pace has time to cross.
    1. 8 s of warning: a siren, a rumble, and the gauge post's marks starting to go under.
    2. 10 s of rising water, then 14 s at the peak, just over the capstones.
    3. 12 s of falling water.
    - Loose timber floats off and drifts downstream. When the water is down, it is left on the near bank
      downstream of the yard, so the run is never lost.
    - What saves the bridge: carrying the bucket over before the peak, a player standing on each beam,
      or holding the beams.
- **The gust:** it comes after 1.5–2.5 s of carrying a plank (only a plank) within 4 m of the
  creek. A stream of leaves blows past as part of the warning. It needs a quiet
  spell after any other hazard, and comes at most three times, and only while three or more planks
  are still out of the creek.
    1. 2.2 s of warning: the windsock swings round and a warning gust blows.
    2. A 2 s gust towards the creek, stronger than one grip.
    - It doesn't take the plank if it is held low (look down), carried by two players, or put down.
- **The handbrake prank:** leave the ute parked on a slope (3.5° or more) with nobody in it for
  6 s, and a ratchet clicks for 2.5 s. Then the handbrake lets go and the ute rolls, for up to
  20 s or until someone gets in the driver's seat. On the flat yard nothing happens. Something
  wedged against a downhill wheel holds it: the cube, a beam or plank on its edge, a log (a plank
  lying flat is too low: the wheel rolls over it). If it ends up
  in the creek, the ute's usual recovery applies: it rights itself, and the driver can drop it back
  on firm ground.
- **The falling tree:** take a bite (or a blow) out of a stand tree while the ute stands within
  5.5 m of it, and the pine cracks: a toast says it leans towards the ute, and the whole tree leans
  over towards it, shaking and shedding needles. It can't fall for 7 s after that, however fast it is chewed. Then, if
  the ute is still in reach, it falls towards it. Moving the ute out of reach, or cutting from the
  ute's side, makes it fall away, on every tree in the stand. At most two, 60 s apart. A tree cut a
  little and left alone sets nothing off until someone cuts it again.
- **The road closure** (the Valley only): crossing Shallow Creek up the forest road (on foot, or
  the ute coming at it), a clunk and a toast, and the sign at the old logging track's mouth swings
  over to a red arrow down the track. A striped barrier stands across the road 11 m further on; the
  ute stops against it (it is fixed until someone takes hold of it). Ways round: the logging track
  (on foot or in the ute), or drag the barrier off the road (one beaver, or two together). Beyond
  its ends is forest, not a wall: note if they pick a way round through the trees. It is over when the barrier is off the road or everyone has
  gone round; the sign only says the road is open when it is. Once a run.
- There is only one hazard at a time, and 15 s of quiet after each one.

## Recording the results

Add a section at the top of `docs/progress.md`:

```markdown
## Playtest: <solo | duo | unfamiliar tester> (<date>)

- **Who and how:** <tester (no names), device, solo / online / split screen>
- **Result:** <finished in m:ss / did not finish> · <falls> falls · <floods> floods, <gusts> gusts
- **Failures and what they said caused them:** <...>
- **Other ways they named:** <...>
- **Hazards:** <noticed the tell? what they did>
- **Confusing or annoying:** <...>
- **Verdict:** <pass / fail per row of the table>
```

Attach or paste the saved log in the issue (#70), not in the repository.
