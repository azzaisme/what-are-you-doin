/**
 * Credits and licences (#104): what the game is made with, shown in the game (Settings → Game →
 * Credits & licences). The full licence texts ship next to the game as third-party-licenses.txt
 * (written by the build: scripts/third-party-licenses.ts). A unit test keeps this list in step with
 * the production dependencies, so a new package can't ship without a credit.
 */

export interface Credit {
    name: string;
    /** npm package names this entry covers (empty for things that aren't packages). */
    packages: string[];
    license: string;
    what: string;
    url: string;
}

export const THIRD_PARTY: readonly Credit[] = [
    {
        name: 'PlayCanvas Engine',
        packages: ['playcanvas'],
        license: 'MIT',
        what: 'the 3D engine, and its camera, sky and water scripts',
        url: 'https://github.com/playcanvas/engine'
    },
    {
        name: 'Rapier',
        packages: ['@dimforge/rapier3d-compat'],
        license: 'Apache-2.0',
        what: 'the physics',
        url: 'https://rapier.rs'
    },
    {
        name: 'Trystero',
        packages: ['trystero', '@trystero-p2p/core', '@trystero-p2p/nostr'],
        license: 'MIT',
        what: 'connecting players peer to peer for online play',
        url: 'https://github.com/dmotz/trystero'
    },
    {
        name: 'noble-secp256k1',
        packages: ['@noble/secp256k1'],
        license: 'MIT',
        what: "signing the matchmaking messages (used by Trystero's Nostr strategy)",
        url: 'https://github.com/paulmillr/noble-secp256k1'
    }
];

/** What is the game's own. */
export const ORIGINAL = [
    'Code, levels, voxel models and animation: made for this game.',
    'Every sound is synthesised in code at start-up; there are no recordings.',
    "Text uses your device's own fonts; no font files are shipped."
];

/** Services online play uses (nothing of ours runs on a server). */
export const SERVICES = [
    'Public Nostr relays help players find each other; game data then goes browser to browser (WebRTC).',
    'A TURN relay may carry game data when no direct route exists, if one is configured.'
];

export const LICENSES_FILE = './third-party-licenses.txt';

/** The credits dialog (DOM only). Text is set with textContent. */
export class CreditsPanel {
    readonly el: HTMLDivElement;
    private readonly close: HTMLButtonElement;
    private opener: Element | null = null;

    constructor() {
        const el = document.createElement('div');
        el.className = 'credits-backdrop';
        el.hidden = true;
        const box = document.createElement('div');
        box.className = 'credits';
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-modal', 'true');
        box.setAttribute('aria-labelledby', 'credits-title');
        const h = document.createElement('h2');
        h.id = 'credits-title';
        h.textContent = 'Credits & licences';
        box.append(h);
        const section = (title: string, lines: string[]) => {
            const t = document.createElement('h3');
            t.textContent = title;
            const ul = document.createElement('ul');
            for (const l of lines) {
                const li = document.createElement('li');
                li.textContent = l;
                ul.append(li);
            }
            box.append(t, ul);
        };
        section('(Un)civil Engineers', ORIGINAL);
        const t = document.createElement('h3');
        t.textContent = 'Made with';
        const ul = document.createElement('ul');
        ul.className = 'credits-third-party';
        for (const c of THIRD_PARTY) {
            const li = document.createElement('li');
            const a = document.createElement('a');
            a.href = c.url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = c.name;
            li.append(a, ` (${c.license}): ${c.what}`);
            ul.append(li);
        }
        box.append(t, ul);
        section('Online play', SERVICES);
        const p = document.createElement('p');
        const full = document.createElement('a');
        full.href = LICENSES_FILE;
        full.target = '_blank';
        full.rel = 'noopener';
        full.className = 'credits-licenses';
        full.textContent = 'Full licence texts';
        p.append(full, ' (every bundled package, with its notice).');
        box.append(p);
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'credits-close';
        close.textContent = 'Close';
        close.addEventListener('click', () => this.hide());
        box.append(close);
        el.append(box);
        el.addEventListener('pointerdown', (e) => {
            if (e.target === el) this.hide();
        });
        // the game below gets none of it
        for (const ev of ['pointerdown', 'mousedown', 'wheel', 'click', 'contextmenu', 'touchstart', 'keyup'] as const)
            el.addEventListener(ev, (e) => e.stopPropagation());
        el.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Escape') {
                e.preventDefault();
                this.hide();
            }
        });
        document.body.append(el);
        this.el = el;
        this.close = close;
    }

    get open(): boolean {
        return !this.el.hidden;
    }

    show(): void {
        this.opener = document.activeElement;
        this.el.hidden = false;
        this.close.focus();
    }

    hide(): void {
        if (this.el.hidden) return;
        this.el.hidden = true;
        if (this.opener instanceof HTMLElement && document.contains(this.opener)) this.opener.focus();
    }
}
