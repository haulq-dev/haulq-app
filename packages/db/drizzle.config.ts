import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? '',
  },
  /**
   * Generated migrations are reviewed and committed, never applied straight
   * from the schema. `drizzle-kit push` is for a throwaway local database only —
   * on anything with real carrier data it will happily drop a column it does not
   * recognize.
   */
  strict: true,
  verbose: true,
});
