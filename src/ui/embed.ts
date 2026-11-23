/**
 * Living inside a web page that isn't ours (#103): itch.io shows the game in a cross-origin iframe.
 * The page around it may make it fullscreen, the player may switch tabs, and the browser grants
 * pointer lock, audio and fullscreen only from a user gesture. This holds the small pieces of that
 * which aren't elsewhere: going full screen from inside the game, and hearing when the page is
 * hidden or shown. (Pointer lock: input/first-person.ts. Audio unlock: audio/game-audio.ts.)
 */

/** Full screen can be asked for here (an iframe needs the embedding page's permission). */
export function fullscreenAvailable(): boolean {
    return typeof document !== 'undefined' && document.fullscreenEnabled === true;
}

export function isFullscreen(): boolean {
    return typeof document !== 'undefined' && !!document.fullscreenElement;
}

/**
 * Enters or leaves full screen (call from a user gesture). Resolves to null, or to a sentence for
 * the player when the browser or the embedding page said no.
 */
export async function setFullscreen(on: boolean): Promise<string | null> {
    try {
        if (on && !isFullscreen()) await document.documentElement.requestFullscreen();
        else if (!on && isFullscreen()) await document.exitFullscreen();
        return null;
    } catch {
        return on ? "Full screen isn't allowed here: use the page's own full screen button" : null;
    }
}

/** Calls back with true when the page is hidden (another tab, minimised), false when it is back. */
export function onPageHidden(cb: (hidden: boolean) => void): () => void {
    const f = () => cb(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', f);
    return () => document.removeEventListener('visibilitychange', f);
}
