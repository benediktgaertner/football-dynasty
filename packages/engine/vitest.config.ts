import { defineConfig } from 'vitest/config';

// Ganze Partien sind rechenintensiv: auf langsamen Rechnern (CI, 2 Kerne) mehr Zeit je Test
export default defineConfig({ test: { testTimeout: 60_000 } });
