import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://sounderpy.app',
  trailingSlash: 'always',
  // 4322 so this can run alongside the personal site's dev server (4321).
  server: { port: 4322 },
});
