import { describe, expect, it } from "vitest";
import {
  DIST_TO_ENEMY_HOME,
  evaluate,
  legalActions,
  planBotTrio,
  sampleTrio,
  scoredActions,
} from "../src/bot";
import { Board, Move, startingBoardState } from "../src/engine";
import { makeRng } from "../src/rng";

function bfs(from: string): Record<string, number> {
  const graph = startingBoardState();
  const dist: Record<string, number> = { [from]: 0 };
  const queue = [from];
  while (queue.length) {
    const node = queue.shift()!;
    for (const n of graph[node].neighbors) {
      if (!(n in dist)) {
        dist[n] = dist[node] + 1;
        queue.push(n);
      }
    }
  }
  return dist;
}

describe("constants", () => {
  it("distance tables match a BFS over the board", () => {
    expect(DIST_TO_ENEMY_HOME[1]).toEqual(bfs("i"));
    expect(DIST_TO_ENEMY_HOME[2]).toEqual(bfs("a"));
  });
});

describe("legalActions", () => {
  it("enumerates neighbors x troop options", () => {
    const actions = legalActions(new Board(), 1); // a: 3 troops, 2 neighbors
    expect(actions).toHaveLength(6);
  });

  it("adds the full-count option above the 8-troop cap", () => {
    const board = new Board();
    board.state.a.troopCount = 12;
    const actions = legalActions(board, 1);
    expect(actions).toHaveLength(18); // 2 neighbors x (8 + full 12)
    expect(actions.some((a) => a.troops === 12)).toBe(true);
  });

  it("is empty when the player has no populated squares", () => {
    const board = new Board();
    board.state.a.troopCount = 0;
    expect(legalActions(board, 1)).toHaveLength(0);
  });
});

describe("scoredActions", () => {
  it("prefers capturing an overwhelmed adjacent enemy", () => {
    const board = new Board();
    board.state.b = { ...board.state.b, owner: 2, troopCount: 1 };
    const top = scoredActions(board, 1)[0];
    expect(top.action.end).toBe("b");
  });

  it("sorts best-first deterministically", () => {
    const board = new Board();
    const once = scoredActions(board, 2).map((s) => s.action);
    const twice = scoredActions(board, 2).map((s) => s.action);
    expect(once).toEqual(twice);
    const scores = scoredActions(board, 2).map((s) => s.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });
});

describe("sampleTrio", () => {
  it("returns three parseable move strings", () => {
    const trio = sampleTrio(new Board(), 2, makeRng("x"), 1);
    expect(trio).toHaveLength(3);
    for (const m of trio) expect(() => new Move(m)).not.toThrow();
  });

  it("emits pass moves when the player has nothing to move", () => {
    const board = new Board();
    board.state.i.troopCount = 0;
    expect(sampleTrio(board, 2, makeRng("x"), 1)).toEqual(["i0h", "i0h", "i0h"]);
  });
});

describe("evaluate", () => {
  it("returns +/-1e6 on win/loss", () => {
    const board = new Board();
    board.state.i.owner = 1;
    expect(evaluate(board, 1)).toBe(1_000_000);
    expect(evaluate(board, 2)).toBe(-1_000_000);
  });

  it("penalizes an exposed home", () => {
    const safe = new Board();
    const exposed = new Board();
    exposed.state.b = { ...exposed.state.b, owner: 2, troopCount: 5 };
    expect(evaluate(exposed, 1)).toBeLessThan(evaluate(safe, 1));
  });

  it("rewards material and progress", () => {
    const ahead = new Board();
    ahead.state.h = { ...ahead.state.h, owner: 2, troopCount: 2 }; // bot advanced
    expect(evaluate(ahead, 2)).toBeGreaterThan(evaluate(new Board(), 2));
  });
});

describe("planBotTrio", () => {
  it("is deterministic per game and round", () => {
    const a = planBotTrio(new Board(), "guid-1", 0);
    const b = planBotTrio(new Board(), "guid-1", 0);
    expect(a).toEqual(b);
    expect(a).toHaveLength(3);
    for (const m of a) expect(() => new Move(m)).not.toThrow();
  });

  it("varies with seed (round or game)", () => {
    const r0 = planBotTrio(new Board(), "guid-1", 0);
    const r1 = planBotTrio(new Board(), "guid-1", 1);
    const g2 = planBotTrio(new Board(), "guid-2", 0);
    expect(
      [r1, g2].some((t) => JSON.stringify(t) !== JSON.stringify(r0))
    ).toBe(true);
  });
});
