import { defineConfig } from 'vitest/config';

// Cell size is a runtime quality setting (5-10 cm), so every unit test runs at both ends of the range.
export default defineConfig({
    test: {
        environment: 'node',
        projects: [
            { extends: true, test: { name: '5cm', include: ['tests/unit/**/*.test.ts'], env: { UE_CELL_CM: '5' } } },
            { extends: true, test: { name: '10cm', include: ['tests/unit/**/*.test.ts'], env: { UE_CELL_CM: '10' } } }
        ]
    }
});
