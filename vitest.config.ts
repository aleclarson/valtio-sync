import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    isolate: false,
    setupFiles: ['./test/setup.ts'],
    typecheck: {
      tsconfig: './test/tsconfig.json',
    },
  },
})
