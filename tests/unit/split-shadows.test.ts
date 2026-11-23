import { describe, expect, it } from 'vitest';

import { QUALITY, splitShadows } from '../../src/render/scene';

describe("split screen: the sun's shadows by number of views", () => {
    it('one or two views keep each preset exactly as it was', () => {
        for (const q of Object.values(QUALITY))
            for (const views of [1, 2]) expect(splitShadows(q, views)).toEqual({ cast: true, cascades: q.cascades });
    });
    it('Low: three views draw one cascade, four none', () => {
        expect(splitShadows(QUALITY.low, 3)).toEqual({ cast: true, cascades: 1 });
        expect(splitShadows(QUALITY.low, 4).cast).toBe(false);
    });
    it('High keeps shadows at three and four views, one cascade fewer', () => {
        for (const views of [3, 4])
            expect(splitShadows(QUALITY.high, views)).toEqual({ cast: true, cascades: QUALITY.high.cascades - 1 });
    });
});
