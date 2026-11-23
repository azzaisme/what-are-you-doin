import { describe, expect, it } from 'vitest';

import { licensesText, productionPackages } from '../../scripts/third-party-licenses.ts';
import { THIRD_PARTY } from '../../src/ui/credits.ts';

describe('credits and licences (#104)', () => {
    const pkgs = productionPackages();

    it('credit every package the build can contain, with its own licence, and nothing else', () => {
        expect(pkgs.length).toBeGreaterThan(0);
        const credited = new Map<string, string>();
        for (const c of THIRD_PARTY) for (const p of c.packages) credited.set(p, c.license);
        expect([...credited.keys()].sort()).toEqual(pkgs.map((p) => p.name).sort());
        for (const p of pkgs) expect(credited.get(p.name), p.name).toBe(p.license);
        // type-only packages put no code in the build
        expect(pkgs.some((p) => p.name.startsWith('@types/') || p.name.endsWith('/types'))).toBe(false);
    });

    it('ship every bundled package’s licence text in third-party-licenses.txt', () => {
        for (const p of pkgs) expect(p.text.length, `${p.name} has a licence file`).toBeGreaterThan(100);
        const txt = licensesText(pkgs);
        for (const p of pkgs) {
            expect(txt).toContain(`${p.name} ${p.version} (${p.license})`);
            expect(txt).toContain(p.text);
        }
        expect(txt).toContain('Apache License');
        expect(txt).toContain('Permission is hereby granted, free of charge');
    });
});
