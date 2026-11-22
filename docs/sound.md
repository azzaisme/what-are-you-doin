# Sound: how to use it from your feature

The game's sound lives in `src/audio/`.

- **Sounds:** every one is made in code (`synth.ts`), so it is original and needs no licence or
  credit.
- **Playback:** `game-audio.ts` plays them through PlayCanvas sound components.
- **What your feature calls:** one small API, `sfx` in `src/audio/sfx.ts`.

## The API

```ts
import { sfx } from '../audio/sfx.ts';

sfx.play('chop', { x, y, z }, { gain: 0.9, pitch: 1 }); // a one-shot at a place
sfx.play('ding'); // a one-shot heard everywhere (no position)
sfx.hold('mill', 'saw', { x, y, z }, { gain: 0.8, pitch: 0.9 }); // a loop: call it every frame it runs
sfx.creak({ x, y, z }, strain); // timber under load, strain 0..1
sfx.snap({ x, y, z }); // something breaks
```

- **Safe before the sound starts.** Browsers only allow sound after the first click, tap or key.
  Until then these calls do nothing, so don't check first.
- **`gain`:** about 0..1, times the player's Effects volume. **`pitch`:** the playback rate (1 as
  made, 0.8 deeper, 1.25 higher). A small random variation is added to every one-shot, so repeats
  don't sound identical.
- **`hold`:** the loop plays while you keep calling it, from one place, keyed by `key`. Two sawmills
  need two keys. Stop calling and it fades out within about a quarter of a second, so you never have
  to stop it.
- **Call from code every device runs.** Only the host runs the simulation. Sound must come from what
  every device sees: the snapshots, the host's HUD and hazard state, or a value you add to the host
  state. Guests then hear it too. If only the host's simulation knows something (a joint's strain,
  for example), send it to guests in the host state and play the sound from that on each device.

## The sounds

| Name                                | What it is                           | Use it for                                                       |
| ----------------------------------- | ------------------------------------ | ---------------------------------------------------------------- |
| `knock` (3 variants)                | a hollow wooden tock                 | timber hitting things (played automatically for props)           |
| `clank` (2)                         | a tinny metal clank                  | the bucket, metal parts                                          |
| `thud` (2)                          | a low thump                          | heavy things landing                                             |
| `splash-small`, `splash-big`        | into the water                       | (automatic for props and players)                                |
| `grab`, `throw`, `drop`             | hands                                | (automatic)                                                      |
| `step` (4)                          | gravel footstep                      | (automatic)                                                      |
| `door`                              | the ute's door                       | (automatic)                                                      |
| `creak` (3)                         | timber groaning under load           | **Epic 5:** joints under strain, through `sfx.creak`             |
| `snap`                              | a crack and splinters                | **Epic 5:** a joint or a piece breaking, through `sfx.snap`      |
| `saw` (loop)                        | a motor hum, blade whine and grit    | **Epic 6:** the sawmill running. `pitch` follows the load        |
| `chop`                              | an axe or teeth biting wood          | **Epic 6:** chopping and chewing                                 |
| `slosh`                             | water moving in the bucket           | **Epic 7:** the bucket's water sloshing. `gain` follows how much |
| `pour` (loop)                       | water pouring and bubbling           | **Epic 7:** filling the bucket, pouring it out                   |
| `ratchet`                           | a ratchet clicking off               | the handbrake prank (automatic)                                  |
| `siren`, `gust-warn`, `gust`        | hazard warnings                      | the flood and the gust (automatic)                               |
| `ding`, `fanfare`                   | a two-note ding and a little fanfare | a step done and the goal (automatic)                             |
| `bird` (3)                          | bird calls                           | ambience (automatic)                                             |
| `engine`, `river`, `wind`, `rumble` | the game's own loops                 | (the ute, the creek, the wind, the flood)                        |

To add a sound:

1. Write a generator in `synth.ts`. Its samples must stay in −1..1, with no clicks at the ends; use
   `fadeEnds`, or `seamless` for a loop.
2. Add its name to `SOUND_NAMES`, and to `LOOPS` and `HELD_LOOPS` if it is a loop that features hold.
3. `tests/unit/audio.test.ts` checks every sound for range, audibility, length and clean ends.

## Volumes

The **Sound** tab in Settings has three sliders:

- **Volume:** everything.
- **Effects:** every `sfx` call, the hazards' warnings, the ute.
- **Ambience:** the creek, wind and birds.

`?sound=off` in the URL mutes the game for one visit.
