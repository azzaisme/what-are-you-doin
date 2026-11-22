import { describe, expect, it } from 'vitest';

import { PlaytestLog } from '../../src/playtest/telemetry.ts';

describe('the playtest log', () => {
    it('records events, players and positions, and sums up the gate’s questions', () => {
        const log = new PlaytestLog({ level: 'Timber Yard', device: 'touch' }, 1000);
        log.note(4000, 'grab', 'P1 took the beam-0');
        log.setPlayers(5000, 2);
        log.sample(6000, {
            players: [{ x: 1, y: 0.4, z: 2, holding: 'beam-0' }],
            bucket: { x: 5.6, y: 0.85, z: 4.4 },
            waterY: -0.45,
            stage: 'Get the bucket across'
        });
        // samples are spaced out
        log.sample(7000, { players: [], bucket: null, waterY: -0.45, stage: '' });
        log.note(30_000, 'hazard', '🚨 A siren upstream! The creek is rising.');
        log.note(40_000, 'fell', 'Splash! Fished out and put back on the bank.');
        log.note(60_000, 'hazard', 'The flood left the beam on the bank downstream.');
        log.note(70_000, 'hazard', '💨 A gust is coming for your plank!');
        log.note(72_000, 'hazard', 'The gust tore it out of your hands!');
        log.note(80_000, 'note', 'they ran for the bucket at the siren');
        log.note(400_000, 'goal', 'Bucket delivered across the creek!');
        const text = log.text(401_000);
        expect(text).toContain('finished: yes, at 6:39');
        expect(text).toContain('most players at once: 2');
        expect(text).toContain('falls into the creek: 1');
        expect(text).toContain('floods: 1 (timber washed downstream 1×); gusts: 1 (torn from hands 1×)');
        expect(text).toContain('facilitator notes: 1');
        expect(text).toContain('first grab: 0:03');
        expect(text).toContain('holding beam-0');
        expect(text.match(/ where /g)).toHaveLength(1);
        expect(log.count('where')).toBe(1);
    });

    it('an unfinished session says so', () => {
        const log = new PlaytestLog({ level: 'Timber Yard' }, 0);
        expect(log.summary(65_000)).toContain('finished: no');
        expect(log.summary(65_000)).toContain('length: 1:05');
    });
});
