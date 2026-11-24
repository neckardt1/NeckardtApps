import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { introspect, typescript } from "@supabase/typegen";

const migrations = new URL("../supabase/migrations/", import.meta.url);
const shared = new URL("../supabase/functions/_shared/", import.meta.url);
const output = new URL("database.types.ts", shared);
const temporary = new URL(`database.types.${randomUUID()}.tmp`, shared);

const db = new PGlite();
try {
  // Hosted Supabase supplies these objects before application migrations run.
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create role supabase_auth_admin;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid stable language sql as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema auth to anon, authenticated, service_role;
  `);
  for (const name of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort()) {
    try {
      await db.exec(await readFile(new URL(name, migrations), "utf8"));
    } catch (cause) {
      throw new Error(`Could not apply migration ${name}`, { cause });
    }
  }
  const metadata = await introspect(db, { includedSchemas: ["public", "flashcards_private"] });
  const source = await typescript.generate(metadata, {}, {
    cwd: process.cwd(), env: {}, format: async code => code
  });
  await mkdir(shared, { recursive: true });
  await writeFile(temporary, source);
  await rename(temporary, output);
  console.log("Generated database types from the SQL migrations.");
} finally {
  await db.close();
  await rm(temporary, { force: true });
}
