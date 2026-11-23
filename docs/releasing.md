# Releasing to itch.io

Releases are automatic: `.github/workflows/itch-release.yml`.

- **Pull request into `main`:** typecheck, lint, formatting, unit tests, the production build and
  the browser smoke tests. Nothing is released.
- **Push to `main` (a merged pull request):** the same tests, then the build in `dist/` goes to
  itch.io with [butler](https://itch.io/docs/butler/) as `azzaisme/water-you-doing:html5`.
  If any test fails, nothing is released.
- **By hand:** Actions → "Test and release to itch.io" → Run workflow (on `main`).

Each release gets the version `<run number>-<commit>` (for example `42-46c4454`). itch.io shows it
on the upload, and butler only uploads the files that changed.

## One-time setup

1. **itch.io project:** create the project `water-you-doing` (if it isn't there yet) and set "Kind
   of project" to **HTML**.
2. **API key:** at <https://itch.io/user/settings/api-keys>, generate a key. In the GitHub
   repository, open Settings → Secrets and variables → Actions → New repository secret, and add
   it as `BUTLER_API_KEY`. Never commit the key.
3. **First release:** merge into `main` (or run the workflow by hand). Then in the itch.io project's
   edit page, tick **"This file will be played in the browser"** on the `html5` upload, and set:
    - viewport 1280 × 720, with "Click to launch in fullscreen" off and the fullscreen button on;
    - "Mobile friendly" on, landscape (touch controls are built in).

    Save. Later releases replace that upload in place, so this is only done once.

4. **Optional:** to release somewhere else, set a repository **variable** `ITCH_TARGET` (for
   example `someone/another-game`).

## Notes

- The itch.io build is `npm run build`. It bundles everything, including the engine and Rapier,
  and uses relative URLs. The claude.ai artifact uses `npm run build:publish` instead, which loads
  the engine from a CDN.
- **Online play on itch.io** is peer to peer (ADR 0012): WebRTC between the players' browsers, set
  up through public Nostr relays. Without a TURN relay, players connect only when a direct route
  exists. That often fails for two devices on one Wi-Fi, and behind strict NATs.

## Optional: a TURN relay for online play

A TURN server carries game data when the players' browsers can't connect directly. Any provider
works, as long as it gives static credentials, for example:

- Metered (Open Relay);
- ExpressTURN;
- a self-hosted coturn.

Add three repository secrets (Settings → Secrets and variables → Actions):

| Secret            | Example                                                                            |
| ----------------- | ---------------------------------------------------------------------------------- |
| `TURN_URLS`       | `turn:relay.example.com:80,turn:relay.example.com:443,turns:relay.example.com:443` |
| `TURN_USERNAME`   | the username the provider gives you                                                |
| `TURN_CREDENTIAL` | the password the provider gives you                                                |

The next release builds them in. They end up in the published game (every browser needs them), so
use a free or capped plan. A guest uses about 12 KB/s, roughly 45 MB an hour.

- The browser tests use software rendering on the GitHub runner, so they take about 10–15 minutes.
  If one fails, the run uploads its screenshots and traces as `playwright-results`.

## Embed checks (what itch's iframe needs)

itch.io shows the game in a cross-origin iframe on its own page. `tests/e2e/embed.spec.ts` plays
the game the same way on every pull request into `main`:

- A stand-in itch page on one host frames the game on another.
- The iframe grants `autoplay; fullscreen *; gamepad`: the features the game uses. This wasn't
  checked against the live itch.io page, so an embed without full screen is tested too.
- Chrome blocks sound until a gesture, as real browsers do.

| Check                 | What the game does (and the test checks)                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Sound                 | The browser keeps it suspended until the first click, tap or key inside the game; then it runs                                  |
| Pointer lock          | Only taken by a click inside the game; that click never grabs the thing under the crosshair. Esc releases it and opens the menu |
| Resizing              | The canvas and the HUD follow the frame's size                                                                                  |
| Full screen           | itch's own button, or Settings → Game → Full screen (only offered where allowed); the canvas fills the screen and returns       |
| Tab hidden            | The sound pauses. A solo game stops at the menu (paused), so you come back to it waiting                                        |
| Online, host hidden   | Guests are told the host's game is in the background and may stop until they come back; they stay in the game                   |
| Online, a peer leaves | A guest who leaves is held for a minute (they can come back). A host who leaves is waited for 20 s, then the guest is told      |

- **Hidden tabs.** Headless Chrome never hides a tab. The test hides the page the way the browser
  announces it: the visibility state changes, and a `visibilitychange` event fires. A host hidden
  for minutes, peer to peer, keeps its guests: Trystero drops a peer only when the WebRTC
  connection closes. See `tests/unit/hidden-host.test.ts`.
- **Plain http.** The test pages are plain `http`. Secure-context features, such as peer-to-peer
  online play, aren't covered there.

## Credits and licences

The build writes `third-party-licenses.txt` next to `index.html`. It holds the licence notice of
every bundled package (`scripts/third-party-licenses.ts`), and Settings → Game → Credits & licences
links to it. Adding a production dependency means adding its credit to `src/ui/credits.ts`:
`tests/unit/credits.test.ts` fails until it is there with the right licence.
