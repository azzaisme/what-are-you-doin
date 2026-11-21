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
