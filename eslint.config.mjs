import typescriptConfig from '@playcanvas/eslint-config/typescript';

export default [
    {
        ignores: [
            '.claude',
            '.agents',
            'public/ammo',
            'dist',
            'dist-publish',
            'scratch',
            'artifacts',
            'test-results',
            'playwright-report'
        ]
    },
    ...typescriptConfig,
    {
        // capture scripts run in Node but evaluate callbacks inside the page
        files: ['scripts/**/*.mjs'],
        languageOptions: {
            globals: {
                window: 'readonly',
                document: 'readonly',
                process: 'readonly',
                requestAnimationFrame: 'readonly'
            }
        }
    }
];
