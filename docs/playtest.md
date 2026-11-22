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
    - **The flood** (when a beam first lies across the gap): do they notice the siren, the rumble and
      the gauge post's marks going under? What do they do? Run with the bucket, stand on the beams,
      hold them, or watch?
    - **The gust** (when carrying a plank near the creek): do they notice the windsock swing round and
      the warning? Do they lower the plank, call their teammate over, put it down, or get it blown in?
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

- **The flood:** it starts 4 s after a beam (or plank) first lies across the gap and is let go, but
  never in the first 20 s of a run, never once the bucket is across, and at most twice.
    1. 8 s of warning: a siren, a rumble, and the gauge post's marks starting to go under.
    2. 10 s of rising water, then 14 s at the peak, just over the capstones.
    3. 12 s of falling water.
    - Loose timber floats off and drifts downstream. When the water is down, it is left on the near bank
      downstream of the yard, so the run is never lost.
    - What saves the bridge: carrying the bucket over before the peak, a player standing on each beam,
      holding the beams, or raising their ends.
- **The gust:** it comes after 1.5 s of carrying a plank within 4 m of the creek. It needs a quiet
  spell after any other hazard, and comes at most three times, and only while three or more planks
  are still out of the creek.
    1. 2.2 s of warning: the windsock swings round and a warning gust blows.
    2. A 2 s gust towards the creek, stronger than one grip.
    - It doesn't take the plank if it is held low (look down), carried by two players, or put down.
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
