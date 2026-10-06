import { test } from "node:test";
import assert from "node:assert/strict";
import { phone } from "./format.ts";

test("phone formats US numbers for display", () => {
  assert.equal(phone("8187141066"), "(818) 714-1066");
  assert.equal(phone("818-714-1066"), "(818) 714-1066");
  assert.equal(phone("(818) 714 1066"), "(818) 714-1066");
  assert.equal(phone("+1 818.714.1066"), "(818) 714-1066");
  assert.equal(phone("18187141066"), "(818) 714-1066");
  assert.equal(phone("818-714-1066 ext 22"), "(818) 714-1066 ext. 22");
  assert.equal(phone("(818) 714-1066 x5"), "(818) 714-1066 ext. 5");
});

test("phone leaves anything else as entered", () => {
  assert.equal(phone("+44 20 7946 0958"), "+44 20 7946 0958");
  assert.equal(phone("555-0100"), "555-0100");
  assert.equal(phone(""), "");
  assert.equal(phone(null), "");
});
