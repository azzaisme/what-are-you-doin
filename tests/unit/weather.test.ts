import { describe, expect, it } from 'vitest';

import { W_PHASE, WEATHER, WeatherScheduler, weatherFogEnd } from '../../src/sim/weather.ts';
import type { WeatherSpec, WeatherZone } from '../../src/sim/weather.ts';

const HZ = 60;
const zone = (over: Partial<WeatherZone>): WeatherZone => ({
    name: 'test',
    kind: WEATHER.rain,
    contains: (x) => x > 10,
    tellS: 2,
    activeS: 10,
    clearS: 3,
    delayS: 4,
    delayJitterS: 0,
    tell: 'gathering',
    clear: 'clearing',
    ...over
});

/** Runs the scheduler with players at `at(tick)` for `ticks`; returns phases and messages seen. */
function run(s: WeatherScheduler, ticks: number, at: (t: number) => { x: number; z: number }[], canStart = () => true) {
    const said: { tick: number; text: string }[] = [];
    const phases: number[] = [];
    for (let t = 0; t < ticks; t++) {
        const m = s.step({ tick: t, hz: HZ, players: at(t), canStart: canStart(), rand: () => 0.5 });
        if (m) said.push({ tick: t, text: m });
        phases.push(s.phase);
    }
    return { said, phases };
}

describe('weather along the journey', () => {
    it('comes once, a moment after the first player reaches the area: gathers, holds, clears', () => {
        const s = new WeatherScheduler({ zones: [zone({})] });
        // a player walks in at tick 100
        const r = run(s, 60 * 40, (t) => [{ x: t < 100 ? 0 : 20, z: 0 }]);
        expect(r.said.map((m) => m.text)).toEqual(['gathering', 'clearing']);
        // it gathers 4 s after arriving
        expect(r.said[0].tick).toBe(100 + 4 * HZ);
        // tell 2 s, then 10 s of weather, then it clears for 3 s and is done for good
        expect(r.said[1].tick).toBe(100 + 4 * HZ + 2 * HZ + 10 * HZ);
        expect(r.phases[r.phases.length - 1]).toBe(W_PHASE.idle);
        expect(r.phases.filter((p) => p === W_PHASE.active).length).toBe(10 * HZ);
    });

    it('waits while another hazard runs, and never comes for an area nobody reached', () => {
        const s = new WeatherScheduler({ zones: [zone({}), zone({ contains: (x) => x < -10, tell: 'other' })] });
        // the director is busy with something else until tick 1000
        let tick = 0;
        const r = run(
            s,
            60 * 40,
            () => [{ x: 20, z: 0 }],
            () => tick++ >= 1000
        );
        expect(r.said[0].tick).toBe(1000);
        expect(r.said.map((m) => m.text)).toEqual(['gathering', 'clearing']);
    });

    it('strength rises through the tell, holds, falls to nothing; river and fog follow it', () => {
        const spec: WeatherSpec = { zones: [zone({ riverRise: 0.2, fogEnd: 40 })] };
        const s = new WeatherScheduler(spec);
        let max = 0;
        let maxRise = 0;
        for (let t = 0; t < 60 * 40; t++) {
            s.step({ tick: t, hz: HZ, players: [{ x: 20, z: 0 }], canStart: true, rand: () => 0 });
            max = Math.max(max, s.strength);
            maxRise = Math.max(maxRise, s.riverRise);
            expect(s.strength).toBeGreaterThanOrEqual(0);
            expect(s.strength).toBeLessThanOrEqual(1);
        }
        expect(max).toBeCloseTo(1, 3);
        expect(maxRise).toBeCloseTo(0.2, 3);
        expect(s.strength).toBe(0);
        expect(weatherFogEnd(spec, 0, 1, 260)).toBe(40);
        expect(weatherFogEnd(spec, 0, 0, 260)).toBe(260);
        expect(weatherFogEnd(spec, -1, 1, 260)).toBe(260);
    });

    it('the same inputs give the same weather (deterministic), and reset starts over', () => {
        const spec: WeatherSpec = {
            zones: [zone({ delayJitterS: 5, kind: WEATHER.snow, wind: { force: 400, dir: 1 } })]
        };
        const trace = () => {
            const s = new WeatherScheduler(spec);
            const out: number[] = [];
            for (let t = 0; t < 60 * 30; t++) {
                s.step({ tick: t, hz: HZ, players: [{ x: 20, z: 0 }], canStart: true, rand: (k) => (k * 0.37) % 1 });
                out.push(s.phase, Math.round(s.strength * 1000), Math.round((s.wind?.force ?? 0) * 10));
            }
            return { out, s };
        };
        const a = trace();
        expect(trace().out).toEqual(a.out);
        a.s.reset();
        expect(a.s.phase).toBe(W_PHASE.idle);
        expect(a.s.kind).toBe(WEATHER.none);
    });
});
