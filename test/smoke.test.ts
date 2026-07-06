import { expect, it } from "vitest";
import { createTestDb } from "./d1-shim";

it("creates a migrated in-memory database", async () => {
  const db = createTestDb();
  const { results } = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('games','moves') ORDER BY name"
    )
    .all<{ name: string }>();
  expect(results.map((r) => r.name)).toEqual(["games", "moves"]);
});
