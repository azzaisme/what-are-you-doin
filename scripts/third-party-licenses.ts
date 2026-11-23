/**
 * Third-party licence notices for the published game (#104). The production build bundles and
 * minifies its dependencies, which drops their licence comments; MIT and Apache-2.0 both ask that
 * the notice travel with the code. So the build writes `third-party-licenses.txt` next to the game,
 * with each bundled package's name, version, licence and full licence text, read from the installed
 * packages (the lockfile says which are production dependencies).
 *
 * Type-only packages (@types/..., @webgpu/types) put no code in the build and are left out. One
 * development package does put code in it: Vite, whose small module-preload helper is bundled
 * with the dynamic import of the online code (BUILD_TIME_CODE).
 */
import fs from 'node:fs';
import path from 'node:path';

import type { Plugin } from 'vite';

export interface ThirdPartyPackage {
    name: string;
    version: string;
    license: string;
    /** The package's licence file, or '' when it ships none. */
    text: string;
}

const TYPES_ONLY = /^@types\/|\/types$/;

/** Development packages whose own code ends up in the bundle, and the part of their licence file to ship. */
export const BUILD_TIME_CODE: { name: string; why: string; cut?: RegExp }[] = [
    // Vite's LICENSE.md is its MIT notice, then the licences of what Vite bundles into itself
    // (which stay in Vite, not in our game): only the first part applies
    { name: 'vite', why: 'its module-preload helper', cut: /^# Licenses of bundled dependencies/m }
];

/** The production packages the build can contain, sorted by name. */
export function productionPackages(root = process.cwd()): ThirdPartyPackage[] {
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as {
        packages: Record<string, { version?: string; license?: string; dev?: boolean; devOptional?: boolean }>;
    };
    const out: ThirdPartyPackage[] = [];
    for (const [key, p] of Object.entries(lock.packages)) {
        if (!key.startsWith('node_modules/') || p.dev || p.devOptional) continue;
        const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
        if (TYPES_ONLY.test(name)) continue;
        const dir = path.join(root, key);
        const file = fs.existsSync(dir)
            ? fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f))
            : undefined;
        out.push({
            name,
            version: p.version ?? '',
            license: p.license ?? 'unknown',
            text: file ? fs.readFileSync(path.join(dir, file), 'utf8').trim() : ''
        });
    }
    for (const b of BUILD_TIME_CODE) {
        const dir = path.join(root, 'node_modules', b.name);
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
            version: string;
            license: string;
        };
        const file = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f));
        let text = file ? fs.readFileSync(path.join(dir, file), 'utf8') : '';
        const at = b.cut ? text.search(b.cut) : -1;
        if (at > 0) text = text.slice(0, at);
        out.push({ name: b.name, version: pkg.version, license: pkg.license, text: text.trim() });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The text of third-party-licenses.txt. */
export function licensesText(pkgs: ThirdPartyPackage[]): string {
    const rule = '-'.repeat(78);
    const head = [
        '(Un)civil Engineers: third-party software',
        '',
        'The game bundles the packages below. Each is listed with its version, its licence and the',
        'licence text it ships with. Everything else in the game (code, models, sounds) is original.',
        ''
    ];
    const body = pkgs.flatMap((p) => [
        rule,
        `${p.name} ${p.version} (${p.license})`,
        rule,
        '',
        p.text || `(no licence file in the package; its licence is ${p.license})`,
        ''
    ]);
    return [...head, ...body].join('\n');
}

/** Vite plugin: emits third-party-licenses.txt into the build. */
export function thirdPartyLicenses(): Plugin {
    return {
        name: 'third-party-licenses',
        apply: 'build',
        generateBundle() {
            this.emitFile({
                type: 'asset',
                fileName: 'third-party-licenses.txt',
                source: licensesText(productionPackages())
            });
        }
    };
}
