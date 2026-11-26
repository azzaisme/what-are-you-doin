/**
 * The bucket's HUD line (Epic 7). A host sends its guests the litres to 0.01 L (`wireLitres`), so
 * every device builds the whole line (the bar and the numbers) from that value: a host and its guests
 * show the same text for the same water.
 */

/** Litres as the host sends them to its guests: to 0.01 L. */
export function wireLitres(v: number): number {
    return Math.round(v * 100) / 100;
}

/**
 * The HUD text for the bucket: a 10-cell bar, the litres in it and, where the stage has a flower,
 * the litres poured into it out of what it needs.
 */
export function waterHudText(volume: number, poured: number, capacity: number, flowerNeeds?: number): string {
    const v = wireLitres(volume);
    const full = Math.max(0, Math.min(10, Math.round((v / capacity) * 10)));
    let t = `Bucket ${'▮'.repeat(full)}${'▯'.repeat(10 - full)} ${v.toFixed(1)} L`;
    if (flowerNeeds !== undefined) t += ` · flower ${wireLitres(poured).toFixed(1)} / ${flowerNeeds} L`;
    return t;
}
