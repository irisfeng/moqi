import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import pg from "pg";

export async function adoptionDatabase(t: TestContext): Promise<string> {
  const database = process.env.DATABASE_URL!;
  const pool = new pg.Pool({ connectionString: database });
  const schema = "adoption_test_" + randomUUID().replaceAll("-", "");
  await pool.query(`CREATE SCHEMA ${schema}`);
  t.after(async () => {
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  });
  const url = new URL(database);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}
