import { describe, expect, it } from "vitest";
import { choice, makeRng } from "../src/rng";

describe("makeRng", () => {
  it("is deterministic per seed string", () => {
    const a = makeRng("guid-1:0");
    const b = makeRng("guid-1:0");
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  it("produces different streams for different seeds", () => {
    const a = makeRng("guid-1:0");
    const b = makeRng("guid-1:1");
    expect([a(), a(), a()]).not.toEqual([b(), b(), b()]);
  });

  it("emits floats in [0, 1)", () => {
    const rand = makeRng("range-check");
    for (let i = 0; i < 1000; i++) {
      const v = rand();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("choice", () => {
  it("picks deterministically from a list", () => {
    const items = ["a", "b", "c", "d"];
    const rand = makeRng("pick");
    const first = choice(items, rand);
    const again = choice(items, makeRng("pick"));
    expect(first).toBe(again);
    expect(items).toContain(first);
  });
});
