/**
 * Prisma CLI configuration — and the one place that decides which database URL a Prisma COMMAND connects with.
 *
 * The schema declares `url = env("DATABASE_URL")` (what the app uses: on Supabase, the transaction pooler) and
 * `directUrl = env("DIRECT_URL")` (what migrations use: a direct connection, or the session pooler). Prisma will not fall back by
 * itself — with DIRECT_URL unset every migrate command stops with P1012 — so this file, which the CLI loads BEFORE it reads the schema
 * however it is invoked (`npx prisma migrate deploy`, the npm scripts, the Render build command), applies src/lib/dbEnv.ts:
 *
 *   DIRECT_URL set                  used; refused if it is a transaction pooler, or in production lacks TLS
 *   DIRECT_URL unset, development   DATABASE_URL is used (refused if that is itself a pooler)
 *   DIRECT_URL unset, production    refused, with a message: never a silent fallback to a pooled URL
 *
 * Commands that connect to nothing (generate, format, --version) are never refused: the Render builds run `prisma generate` with no
 * DIRECT_URL. The running app never reads DIRECT_URL — it connects with DATABASE_URL only.
 *
 * Why a config file does this and not the schema: a schema cannot express a default for env(), and the CLI skips its own .env loading
 * once a config file exists, so this loads .env too. (The seed command moved here from the deprecated package.json#prisma.)
 */
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';
import { DbEnvError, isConnectingCommand, prismaCliEnv } from './src/lib/dbEnv.js';

// DOTENV_CONFIG_PATH names the file (what `dotenv/config` honours; `config()` alone does not) — tests point it at a file of their own.
loadEnv({ quiet: true, path: process.env.DOTENV_CONFIG_PATH || undefined });

const command = process.argv[2] ?? '';
try {
  const cli = prismaCliEnv(process.env, command);
  if (cli.env.DIRECT_URL !== undefined) process.env.DIRECT_URL = cli.env.DIRECT_URL;
  if (cli.fellBack && isConnectingCommand(command)) {
    console.error('DIRECT_URL is not set: using DATABASE_URL for this command (development only; production requires DIRECT_URL).');
  }
} catch (e) {
  if (!(e instanceof DbEnvError)) throw e;
  console.error(`prisma ${command}: ${e.message}`);
  process.exit(1);
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { seed: 'tsx prisma/seed.ts' },
});
