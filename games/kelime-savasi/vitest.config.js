import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    environment: 'node',
    // Sözlük yüklemesi (~30K kelime → Set + anagram index) beforeAll'da çalışıyor
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
