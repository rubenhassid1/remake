import assert from "node:assert/strict";
import { test } from "node:test";
import { blank, compare } from "../engine/lib/diff.mjs";
import { verdict } from "../engine/lib/score.mjs";

const pixel = blank(1, 1, [10, 20, 30, 255]);

test("all-masked motion is unscorable and never passes", () => {
  const result = compare(pixel, pixel, new Uint8Array([1]));
  assert.equal(result.considered, 0);
  assert.equal(result.unscorable, true);
  assert.equal(result.score, 0);
  const score = { pages: {}, motion: { frames: [{ i: 0, score: result.score, unscorable: result.unscorable }] } };
  assert.deepEqual(verdict(score, { thresholds: { screen: 98, motion: 95 }, viewports: {} }), {
    pass: false,
    failing: ["motion frame 1: no stable pixels (retry with remake score --fresh)"],
  });
});

test("stable matching pixel passes", () => {
  const result = compare(pixel, pixel, new Uint8Array([0]));
  assert.equal(result.considered, 1);
  assert.equal(result.unscorable, false);
  assert.equal(result.score, 100);
});
