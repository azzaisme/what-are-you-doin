import { describe, expect, it } from 'vitest';

import { BUCKET_CAPACITY } from '../../src/assets/props.ts';
import { WATER } from '../../src/sim/water.ts';
import { waterHudText, wireLitres } from '../../src/ui/water-hud.ts';

// the host's HUD reads its own water; a guest's reads what the host sent it (`wireLitres`)
const host = (volume: number, poured: number, flower?: number) => waterHudText(volume, poured, BUCKET_CAPACITY, flower);
const guest = (volume: number, poured: number, flower?: number) =>
    waterHudText(wireLitres(volume), wireLitres(poured), BUCKET_CAPACITY, flower);

describe('the bucket HUD: a host and its guests show the same line', () => {
    it('reads as before for plain values', () => {
        expect(host(10, 0)).toBe('Bucket ▮▮▮▮▮▮▮▮▮▮ 10.0 L');
        expect(host(0, 0)).toBe('Bucket ▯▯▯▯▯▯▯▯▯▯ 0.0 L');
        expect(host(7.3, 1.2, WATER.minDelivery)).toBe(`Bucket ▮▮▮▮▮▮▮▯▯▯ 7.3 L · flower 1.2 / ${WATER.minDelivery} L`);
    });

    // just under a half on the host, a whole half once sent to 0.01 L: the bar cell and the
    // litres both round up on a guest, so the host must round from the same value
    for (const v of [9.4996, 4.4951, 0.4996, 9.2496, 9.2451, 0.0496, 5.0496])
        it(`the same full line (bar and litres) at ${v} L`, () => {
            expect(guest(v, 0)).toBe(host(v, 0));
            expect(guest(10 - v, v, WATER.minDelivery)).toBe(host(10 - v, v, WATER.minDelivery));
        });

    it('the bar cell and the litres agree on 9.4996 L: ten cells, 9.5 L', () => {
        expect(host(9.4996, 0)).toBe('Bucket ▮▮▮▮▮▮▮▮▮▮ 9.5 L');
    });

    it('the same line over the whole bucket, in 0.0001 L steps', () => {
        let differ = 0;
        for (let i = 0; i <= 100_000; i++) {
            const v = i / 10_000;
            if (host(v, v, WATER.minDelivery) !== guest(v, v, WATER.minDelivery)) differ++;
        }
        expect(differ).toBe(0);
    });
});
