import { defineConfig } from 'vitest/config';

// Kept separate from vite.config.ts, which sets `root: 'app'` for the
// application build. Tests live at the repository root.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
