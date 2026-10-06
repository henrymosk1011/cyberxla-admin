import { test } from "node:test";
import assert from "node:assert/strict";
import { CATALOG, CATEGORIES } from "./catalog.ts";

test("every service is in exactly one category", () => {
  const listed = CATEGORIES.flatMap((c) => c.ids);
  assert.equal(new Set(listed).size, listed.length, "duplicate id in categories");
  assert.deepEqual([...listed].sort(), Object.keys(CATALOG).sort());
});
