import { describe, expect, it } from "vitest";
import { Move, MovePair } from "../src/engine";
import { ImproperlyFormattedMove, InvalidMove } from "../src/exceptions";

describe("Move", () => {
  it("parses start, troop count, and end", () => {
    const move = new Move("a3b");
    expect(move.start).toBe("a");
    expect(move.troopCount).toBe(3);
    expect(move.end).toBe("b");
  });

  it("round-trips to string", () => {
    expect(new Move("i42h").toString()).toBe("i42h");
  });

  it("throws ImproperlyFormattedMove on garbage", () => {
    expect(() => new Move("3ab")).toThrow(ImproperlyFormattedMove);
    expect(() => new Move("")).toThrow(ImproperlyFormattedMove);
    expect(() => new Move("xyz")).toThrow(/A valid move must have the form/);
  });

  it("throws InvalidMove on non-adjacent squares", () => {
    expect(() => new Move("a1i")).toThrow(InvalidMove);
    expect(() => new Move("a1i")).toThrow("Invalid move: 'a1i'.");
  });

  it("throws InvalidMove on unknown squares (Python crashed with KeyError here)", () => {
    expect(() => new Move("z1a")).toThrow(InvalidMove);
  });

  it("ignores trailing garbage like the Python regex (re.match, not fullmatch)", () => {
    expect(new Move("a3b!!").toString()).toBe("a3b");
  });
});

describe("MovePair", () => {
  it("detects swaps", () => {
    const pair = new MovePair(new Move("a1b"), new Move("b1a"));
    expect(pair.isSwap).toBe(true);
    expect(pair.isCollision).toBe(false);
  });

  it("detects collisions", () => {
    const pair = new MovePair(new Move("a1b"), new Move("c1b"));
    expect(pair.isCollision).toBe(true);
    expect(pair.isSwap).toBe(false);
  });
});
