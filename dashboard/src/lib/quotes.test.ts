import { test } from "node:test";
import assert from "node:assert/strict";
import { statusLabel } from "./quotes.ts";

test("a quote published without an email says so in place of Sent", () => {
  assert.equal(statusLabel({ status: "sent", link_only: true }), "Published, not emailed");
  assert.equal(statusLabel({ status: "sent", link_only: false }), "Sent");
});

test("other statuses keep their own words, emailed or not", () => {
  // Once the client opens it, Viewed says more than how it got there.
  assert.equal(statusLabel({ status: "viewed", link_only: true }), "Viewed");
  assert.equal(statusLabel({ status: "accepted", link_only: true }), "Accepted");
  assert.equal(statusLabel({ status: "draft", link_only: false }), "Draft");
});
