import { defineConfig } from 'tsdown'
import ApiSnapshot from 'tsnapi/rolldown'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/client.ts',
    'src/server.ts',
    'src/schema.ts',
    'src/drizzle.ts',
  ],
  format: ['esm'],
  dts: true,
  external: [
    'drizzle-orm',
    'valtio',
    'zod',
  ],
  plugins: [
    ApiSnapshot(),
  ],
})
