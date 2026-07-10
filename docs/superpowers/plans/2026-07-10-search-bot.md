# Search Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship play-against-bot in allsfair-worker per `docs/superpowers/specs/2026-07-10-search-bot-design.md`: trio-level candidate search bot, asset-free, deterministic, wired into the existing ML seam.

**Architecture:** `src/bot.ts` plans a bot trio by sampling 16 candidate trios from a heuristic action scorer, simulating each against 6 sampled opponent trios with the real engine (full round + restock), and scoring boards with a hand-tuned eval (0.25·min + 0.75·mean). `src/actions.ts` fills the dormant ML seam: `create_game` mints `__ML_BOT__` secrets, and after player 1 finishes a trio the bot's trio is planned from the round-start board and written idempotently.

**Tech Stack:** TypeScript, existing engine (`src/engine.ts`), D1 via `src/db.ts`, vitest with the node:sqlite shim (`test/d1-shim.ts`).

## Global Constraints

- Bot search parameters (from measurement): `N_CANDIDATES = 16`, `K_OPPONENT = 6`, `MIN_WEIGHT = 0.25`, `MAX_TROOPS_PER_ACTION = 8`.
- Eval weights: win/loss ±1,000,000; material ×3; squares ×2; progress ×0.6; exposure ×1.5 (threat = enemy troops at distance ≤2 of home, weight (3−dist), ×2, minus garrison, floor 0; +50 if home enemy-owned); enemy-home-capture +6.
- Determinism: seed string `` `${gameGuid}:${completedRounds}` `` → cyrb128 → mulberry32. NO `Math.random()`/`Date.now()` anywhere in src/.
- Bot plans from the round-start board only — never reads P1's current-round moves.
- Pass move: `"a0b"` (P1) / `"i0h"` (P2); 0 troops is an engine no-op.
- No D1 schema changes; no API shape changes; no new dependencies.
- Existing v1 tests asserting the 400 `"Play against ML is not yet supported"` must be replaced (behavior is removed), not deleted silently.
- Working directory: `/Users/floyd/code/allsfair/allsfair-worker`. Run tests as `npm test` (sets `NODE_OPTIONS=--experimental-sqlite`); single files as `NODE_OPTIONS=--experimental-sqlite npx vitest run <file>`.

## File Structure

```
src/rng.ts          NEW  seeded PRNG: cyrb128, mulberry32, makeRng, choice
src/bot.ts          NEW  distances, legalActions, scoredActions, sampleTrio,
                         evaluate, planTrio, planBotTrio
src/engine.ts       MOD  Board.clone(), Board.applyPlannedMove()
src/db.ts           MOD  getMlRoundContext()
src/actions.ts      MOD  ML create_game, generateMlMovesIfNeeded, hooks
public/index.html   MOD  unhide bot checkbox
test/rng.test.ts    NEW
test/bot.test.ts    NEW  unit tests
test/bot.strength.test.ts NEW  strength gates
test/engine.board.test.ts MOD  clone/applyPlannedMove tests
test/db.test.ts     MOD  round-context test
test/actions.test.ts MOD  ML game tests, replace v1-400 test
test/integration.test.ts MOD  bot game over HTTP, replace v1-400 test
```

---

### Task 1: Seeded RNG

**Files:**
- Create: `src/rng.ts`
- Test: `test/rng.test.ts`

**Interfaces:**
- Produces: `makeRng(seedString: string): () => number` (floats in [0,1), deterministic per seed), `choice<T>(items: T[], rand: () => number): T`. Also exports `cyrb128(str: string): number` and `mulberry32(seed: number): () => number` (used only via `makeRng`).

- [ ] **Step 1: Write the failing test**

`test/rng.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS=--experimental-sqlite npx vitest run test/rng.test.ts`
Expected: FAIL — cannot resolve `../src/rng`.

- [ ] **Step 3: Write the implementation**

`src/rng.ts`:

```ts
// Deterministic seeded PRNG for bot planning. Workers may not use
// Math.random()/Date.now() in request-deterministic paths; the bot seeds
// from `${gameGuid}:${completedRounds}` so replays produce identical trios.

export function cyrb128(str: string): number {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return (h1 ^ h2 ^ h3 ^ h4) >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeRng(seedString: string): () => number {
  return mulberry32(cyrb128(seedString));
}

export function choice<T>(items: T[], rand: () => number): T {
  return items[Math.floor(rand() * items.length)];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_OPTIONS=--experimental-sqlite npx vitest run test/rng.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/rng.ts test/rng.test.ts
git commit -m "feat: add deterministic seeded RNG for bot planning"
```

---

### Task 2: Engine planning helpers

**Files:**
- Modify: `src/engine.ts` (append two methods inside `class Board`)
- Test: `test/engine.board.test.ts` (append describe block)

**Interfaces:**
- Consumes: existing `Board`, `Move`.
- Produces: `Board.clone(): Board` (fresh Board with a deep copy of `state`, empty history) and `Board.applyPlannedMove(move: Move, team: number): void` (single-side move for bot planning: no-op unless the team owns a populated start square; clamps troops; then standard engine move/attack semantics — port of Python `ml/planning.py::apply_planned_action`).

- [ ] **Step 1: Write the failing test**

Append to `test/engine.board.test.ts`:

```ts
describe("planning helpers", () => {
  it("clone copies state without sharing mutations", () => {
    const board = new Board();
    const copy = board.clone();
    copy.state.a.troopCount = 99;
    expect(board.state.a.troopCount).toBe(3);
    expect(copy.history).toHaveLength(0);
  });

  it("applyPlannedMove moves troops with clamping", () => {
    const board = new Board();
    board.applyPlannedMove(new Move("a9b"), 1);
    expect(board.state.a.troopCount).toBe(0);
    expect(board.state.b).toMatchObject({ owner: 1, troopCount: 3 });
  });

  it("applyPlannedMove is a no-op from unowned or empty squares", () => {
    const board = new Board();
    board.applyPlannedMove(new Move("b1e"), 1); // b unowned
    expect(board.state.e).toMatchObject({ owner: 0, troopCount: 0 });
    board.applyPlannedMove(new Move("i1h"), 1); // i owned by team 2
    expect(board.state.h.troopCount).toBe(0);
  });

  it("applyPlannedMove attacks with engine combat semantics", () => {
    const board = new Board();
    board.state.b = { ...board.state.b, owner: 2, troopCount: 1 };
    board.applyPlannedMove(new Move("a3b"), 1);
    expect(board.state.b).toMatchObject({ owner: 1, troopCount: 2 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS=--experimental-sqlite npx vitest run test/engine.board.test.ts`
Expected: FAIL — `clone is not a function`.

- [ ] **Step 3: Append methods to `class Board` in `src/engine.ts`**

```ts
  /** Game-state clone for bot planning: copied state, fresh empty history. */
  clone(): Board {
    const copy = new Board();
    copy.state = structuredClone(this.state);
    return copy;
  }

  /**
   * Apply a single team's move outside pair resolution (bot planning only):
   * no-op unless the team owns a populated start square; clamps troops to
   * what the square holds, then standard move/attack semantics.
   */
  applyPlannedMove(move: Move, team: number): void {
    const start = this.state[move.start];
    if (start.owner !== team || start.troopCount <= 0) return;
    move.troopCount = Math.min(move.troopCount, start.troopCount);
    start.troopCount -= move.troopCount;
    this.applyMove(move, team);
  }
```

- [ ] **Step 4: Run tests — engine suite AND parity (guard against engine regressions)**

Run: `NODE_OPTIONS=--experimental-sqlite npx vitest run test/engine.board.test.ts test/parity.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/engine.ts test/engine.board.test.ts
git commit -m "feat: add Board.clone and applyPlannedMove for bot planning"
```

---

### Task 3: Bot brain

**Files:**
- Create: `src/bot.ts`
- Test: `test/bot.test.ts`

**Interfaces:**
- Consumes: `Board`, `Move`, `MovePair`, `startingBoardState`, `TEAM_1`, `TEAM_2` from `./engine`; `makeRng`, `choice` from `./rng`.
- Produces (Task 4/6 rely on these exact names):
  - `planBotTrio(board: Board, gameGuid: string, completedRounds: number): string[]` — 3 move strings for player 2.
  - `sampleTrio(board: Board, player: number, rand: () => number, topN: number): string[]`
  - `legalActions(board: Board, player: number): { start: string; troops: number; end: string }[]`
  - `scoredActions(board: Board, player: number): { score: number; action: { start: string; troops: number; end: string } }[]` (sorted best-first)
  - `evaluate(board: Board, me: number): number`
  - `PASS_MOVE: Record<number, string>`, `DIST_TO_ENEMY_HOME: Record<number, Record<string, number>>`, `N_CANDIDATES`, `K_OPPONENT`, `MIN_WEIGHT`.

- [ ] **Step 1: Write the failing test**

`test/bot.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS=--experimental-sqlite npx vitest run test/bot.test.ts`
Expected: FAIL — cannot resolve `../src/bot`.

- [ ] **Step 3: Write the implementation**

`src/bot.ts`:

```ts
// Trio-level candidate-search bot. Port of the measured Python prototype
// (allsfair repo, scripts/search_bot_eval.py): 76% wins vs heuristic,
// 94% vs the old hybrid Q-bot. Weights and parameters are measured values —
// re-run the Python eval harness before changing them.
import {
  Board,
  Move,
  MovePair,
  TEAM_1,
  TEAM_2,
} from "./engine";
import { choice, makeRng } from "./rng";

export const N_CANDIDATES = 16;
export const K_OPPONENT = 6;
export const MIN_WEIGHT = 0.25;
export const MAX_TROOPS_PER_ACTION = 8;
const MOVES_PER_ROUND = 3;

export const PASS_MOVE: Record<number, string> = { 1: "a0b", 2: "i0h" };

// BFS distances to the ENEMY home on the fixed 9-node board
// (test/bot.test.ts asserts these equal a BFS over startingBoardState()).
export const DIST_TO_ENEMY_HOME: Record<number, Record<string, number>> = {
  1: { a: 4, b: 3, c: 2, d: 3, e: 2, f: 1, g: 2, h: 1, i: 0 },
  2: { a: 0, b: 1, c: 2, d: 1, e: 2, f: 3, g: 2, h: 3, i: 4 },
};

export interface CandidateAction {
  start: string;
  troops: number;
  end: string;
}

function toMoveString(a: CandidateAction): string {
  return `${a.start}${a.troops}${a.end}`;
}

export function legalActions(board: Board, player: number): CandidateAction[] {
  const actions: CandidateAction[] = [];
  for (const start of board.populatedSquaresOwned(player)) {
    const node = board.state[start];
    const troopOptions: number[] = [];
    const capped = Math.min(node.troopCount, MAX_TROOPS_PER_ACTION);
    for (let t = 1; t <= capped; t++) troopOptions.push(t);
    if (node.troopCount > MAX_TROOPS_PER_ACTION) {
      troopOptions.push(node.troopCount);
    }
    for (const end of node.neighbors) {
      for (const troops of troopOptions) {
        actions.push({ start, troops, end });
      }
    }
  }
  return actions;
}

export function scoredActions(
  board: Board,
  player: number
): { score: number; action: CandidateAction }[] {
  const opponent = player === 1 ? TEAM_2 : TEAM_1;
  const dist = DIST_TO_ENEMY_HOME[player];
  const enemyHome = player === 1 ? "i" : "a";

  const scored = legalActions(board, player).map((action) => {
    const destination = board.state[action.end];
    let score = (dist[action.start] - dist[action.end]) * 1.2;
    score += action.troops * 0.08;
    if (destination.owner === opponent) {
      score += Math.min(action.troops, destination.troopCount) * 0.6;
      if (action.troops >= destination.troopCount) score += 1.0;
    } else if (destination.owner === 0) {
      score += 0.45;
    }
    if (action.end === enemyHome) score += 1.5;
    return { score, action };
  });

  scored.sort(
    (x, y) =>
      y.score - x.score ||
      (toMoveString(x.action) < toMoveString(y.action) ? -1 : 1)
  );
  return scored;
}

/** Heuristic trio; topN > 1 samples each slot from the top-n actions. */
export function sampleTrio(
  board: Board,
  player: number,
  rand: () => number,
  topN: number
): string[] {
  const plan = board.clone();
  const moves: string[] = [];
  for (let i = 0; i < MOVES_PER_ROUND; i++) {
    const scored = scoredActions(plan, player);
    if (scored.length === 0) {
      moves.push(PASS_MOVE[player]);
      continue;
    }
    const pool = scored.slice(0, Math.min(topN, scored.length));
    const { action } = choice(pool, rand);
    const moveString = toMoveString(action);
    plan.applyPlannedMove(new Move(moveString), player);
    moves.push(moveString);
  }
  return moves;
}

export function evaluate(board: Board, me: number): number {
  const them = me === 1 ? TEAM_2 : TEAM_1;
  const winner = board.winner;
  if (winner === me) return 1_000_000;
  if (winner === them) return -1_000_000;

  const myHome = me === 1 ? "a" : "i";
  const theirHome = them === 1 ? "a" : "i";
  const myDist = DIST_TO_ENEMY_HOME[me];
  const theirDist = DIST_TO_ENEMY_HOME[them];

  let material = 0;
  let squares = 0;
  let progress = 0;
  let homeThreat = 0;

  for (const [name, node] of Object.entries(board.state)) {
    if (node.owner === me && node.troopCount > 0) {
      material += node.troopCount;
      squares += 1;
      progress += node.troopCount * (4 - myDist[name]);
    } else if (node.owner === them && node.troopCount > 0) {
      material -= node.troopCount;
      squares -= 1;
      progress -= node.troopCount * (4 - theirDist[name]);
      // their distance-to-enemy-home IS their distance to MY home
      const distToMyHome = theirDist[name];
      if (distToMyHome <= 2) {
        homeThreat += node.troopCount * (3 - distToMyHome);
      }
    }
  }

  const myHomeNode = board.state[myHome];
  const garrison = myHomeNode.owner === me ? myHomeNode.troopCount : 0;
  if (myHomeNode.owner === them) homeThreat += 50;
  const exposed = Math.max(0, homeThreat * 2 - garrison);
  const captureProgress = board.state[theirHome].owner === me ? 6 : 0;

  return (
    material * 3 + squares * 2 + progress * 0.6 - exposed * 1.5 + captureProgress
  );
}

function simulateRound(
  board: Board,
  myTrio: string[],
  oppTrio: string[],
  me: number
): number {
  const sim = board.clone();
  for (let i = 0; i < MOVES_PER_ROUND; i++) {
    const [p1, p2] =
      me === 1 ? [myTrio[i], oppTrio[i]] : [oppTrio[i], myTrio[i]];
    sim.applyMovePair(new MovePair(new Move(p1), new Move(p2)));
    if (sim.winner) break;
  }
  sim.restock();
  return evaluate(sim, me);
}

export function planTrio(
  board: Board,
  me: number,
  rand: () => number
): string[] {
  const them = me === 1 ? TEAM_2 : TEAM_1;

  const candidates: string[][] = [sampleTrio(board, me, rand, 1)];
  for (let i = 1; i < N_CANDIDATES; i++) {
    candidates.push(sampleTrio(board, me, rand, 3));
  }
  const seen = new Set<string>();
  const unique = candidates.filter((trio) => {
    const key = trio.join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const oppTrios: string[][] = [sampleTrio(board, them, rand, 1)];
  for (let i = 1; i < K_OPPONENT; i++) {
    oppTrios.push(sampleTrio(board, them, rand, 3));
  }

  let best = unique[0];
  let bestScore = -Infinity;
  for (const trio of unique) {
    const outcomes = oppTrios.map((opp) => simulateRound(board, trio, opp, me));
    const mean = outcomes.reduce((a, b) => a + b, 0) / outcomes.length;
    const score =
      MIN_WEIGHT * Math.min(...outcomes) + (1 - MIN_WEIGHT) * mean;
    if (score > bestScore) {
      bestScore = score;
      best = trio;
    }
  }
  return best;
}

/** Entry point: plan player 2's trio for the given round, deterministically. */
export function planBotTrio(
  board: Board,
  gameGuid: string,
  completedRounds: number
): string[] {
  const rand = makeRng(`${gameGuid}:${completedRounds}`);
  return planTrio(board, 2, rand);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_OPTIONS=--experimental-sqlite npx vitest run test/bot.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add src/bot.ts test/bot.test.ts
git commit -m "feat: add trio-search bot brain (measured 76% vs heuristic)"
```

---

### Task 4: Strength gates

**Files:**
- Test: `test/bot.strength.test.ts`

**Interfaces:**
- Consumes: `planBotTrio`, `sampleTrio`, `legalActions`, `PASS_MOVE` from `../src/bot`; `Board`, `Move`, `MovePair` from `../src/engine`; `choice`, `makeRng` from `../src/rng`.

- [ ] **Step 1: Write the strength test**

`test/bot.strength.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { legalActions, PASS_MOVE, planBotTrio, sampleTrio } from "../src/bot";
import { Board, Move, MovePair } from "../src/engine";
import { choice, makeRng } from "../src/rng";

const MAX_ROUNDS = 40;

type TrioPlanner = (board: Board, gameIndex: number, round: number) => string[];

function playGame(p1: TrioPlanner, p2: TrioPlanner, gameIndex: number): number {
  const board = new Board();
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const t1 = p1(board, gameIndex, round);
    const t2 = p2(board, gameIndex, round);
    for (let i = 0; i < 3; i++) {
      board.applyMovePair(new MovePair(new Move(t1[i]), new Move(t2[i])));
    }
    board.restock();
    if (board.winner) return board.winner;
  }
  return 0;
}

const searchP2: TrioPlanner = (board, g, r) =>
  planBotTrio(board, `strength-${g}`, r);

const heuristicP1: TrioPlanner = (board, g, r) =>
  sampleTrio(board, 1, makeRng(`h-${g}-${r}`), 1);

const randomP1: TrioPlanner = (board, g, r) => {
  const rand = makeRng(`rand-${g}-${r}`);
  const plan = board.clone();
  const moves: string[] = [];
  for (let i = 0; i < 3; i++) {
    const actions = legalActions(plan, 1);
    if (actions.length === 0) {
      moves.push(PASS_MOVE[1]);
      continue;
    }
    const a = choice(actions, rand);
    const s = `${a.start}${a.troops}${a.end}`;
    plan.applyPlannedMove(new Move(s), 1);
    moves.push(s);
  }
  return moves;
};

describe("bot strength gates", () => {
  it("beats the heuristic in >=60% of 50 games", () => {
    let wins = 0;
    for (let g = 0; g < 50; g++) {
      if (playGame(heuristicP1, searchP2, g) === 2) wins++;
    }
    expect(wins).toBeGreaterThanOrEqual(30);
  });

  it("beats a random mover in >=90% of 50 games", () => {
    let wins = 0;
    for (let g = 0; g < 50; g++) {
      if (playGame(randomP1, searchP2, g) === 2) wins++;
    }
    expect(wins).toBeGreaterThanOrEqual(45);
  });
});
```

- [ ] **Step 2: Run it**

Run: `NODE_OPTIONS=--experimental-sqlite npx vitest run test/bot.strength.test.ts`
Expected: PASS. Note the actual win counts from any failure output. If a gate fails, the port diverges from the measured prototype — debug the port against `allsfair/scripts/search_bot_eval.py` behavior (eval weights, sampler pools, min/mean mix); do NOT lower the thresholds.

- [ ] **Step 3: Commit**

```bash
git add test/bot.strength.test.ts
git commit -m "test: add bot strength gates (>=60% vs heuristic, >=90% vs random)"
```

---

### Task 5: Round context query

**Files:**
- Modify: `src/db.ts` (append function)
- Test: `test/db.test.ts` (append tests)

**Interfaces:**
- Consumes: existing `getMovesForGuid`, `Board`, `Move`, `MovePair`.
- Produces: `getMlRoundContext(db: D1Database, gameGuid: string, roundIndex: number): Promise<{ board: Board; botMovesInRound: string[] }>` — board replayed through `roundIndex * 3` pairs (restock every 3rd), plus player-2 move strings already written for that round (0–3 entries). Port of Python `db.py::get_ml_round_context`.

- [ ] **Step 1: Write the failing test**

Append to `test/db.test.ts` (add `getMlRoundContext` to the existing import from `../src/db`):

```ts
describe("getMlRoundContext", () => {
  it("returns a fresh board and partial bot moves for round 0", async () => {
    for (const m of ["a1b", "a1d", "b1e"]) {
      await writeMove(db, "g-ml", new Move(m), 1);
    }
    for (const m of ["i1h", "i1f"]) {
      await writeMove(db, "g-ml", new Move(m), 2);
    }
    const ctx = await getMlRoundContext(db, "g-ml", 0);
    expect(ctx.board.state.a.troopCount).toBe(3); // round-start = untouched
    expect(ctx.botMovesInRound).toEqual(["i1h", "i1f"]);
  });

  it("replays prior rounds for round 1", async () => {
    for (const m of ["a1b", "a1d", "b1e"]) {
      await writeMove(db, "g-ml2", new Move(m), 1);
    }
    for (const m of ["i1h", "i1f", "h1e"]) {
      await writeMove(db, "g-ml2", new Move(m), 2);
    }
    const ctx = await getMlRoundContext(db, "g-ml2", 1);
    // round 0 fully replayed incl. restock (3 squares each: a/b/d and i/h/f... 
    // pair 3 b1e vs h1e equal-collides, so a owns a,b,d and i owns i,h,f)
    expect(ctx.board.state.a.troopCount).toBe(4);
    expect(ctx.board.state.i.troopCount).toBe(4);
    expect(ctx.botMovesInRound).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS=--experimental-sqlite npx vitest run test/db.test.ts`
Expected: FAIL — `getMlRoundContext` not exported.

- [ ] **Step 3: Append to `src/db.ts`**

```ts
export async function getMlRoundContext(
  db: D1Database,
  gameGuid: string,
  roundIndex: number
): Promise<{ board: Board; botMovesInRound: string[] }> {
  const moves = await getMovesForGuid(db, gameGuid);
  const p1Moves: Move[] = [];
  const p2Moves: Move[] = [];
  for (const m of moves) {
    (m.player === 1 ? p1Moves : p2Moves).push(new Move(m.moveString));
  }

  const board = new Board();
  const priorPairCount = roundIndex * 3;
  const pairCount = Math.min(priorPairCount, p1Moves.length, p2Moves.length);
  for (let i = 0; i < pairCount; i++) {
    board.applyMovePair(new MovePair(p1Moves[i], p2Moves[i]));
    if ((i + 1) % 3 === 0) board.restock();
  }

  const botMovesInRound = p2Moves
    .slice(priorPairCount, priorPairCount + 3)
    .map((m) => m.toString());
  return { board, botMovesInRound };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_OPTIONS=--experimental-sqlite npx vitest run test/db.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db.ts test/db.test.ts
git commit -m "feat: add getMlRoundContext for bot round planning"
```

---

### Task 6: Action wiring

**Files:**
- Modify: `src/actions.ts`
- Test: `test/actions.test.ts`

**Interfaces:**
- Consumes: `planBotTrio` from `./bot`; `getMlRoundContext` from `./db`; everything already imported.
- Produces: `create_game` honoring `play_against_ml`; internal `generateMlMovesIfNeeded(d1, gameGuid, rs): Promise<RoundState>`; bot hooks in `submitMove` and `getMoves`.

- [ ] **Step 1: Update the tests**

In `test/actions.test.ts`, REPLACE the test `"rejects play_against_ml in v1 (bot seam)"` with:

```ts
  it("creates a bot game when play_against_ml is set", async () => {
    const resp = await createGame(db, { play_against_ml: true });
    expect(resp.play_against_ml).toBe(true);
    const game = await getGameByGuid(db, resp.game_guid);
    expect(game.player2Secret.startsWith("__ML_BOT__")).toBe(true);
    expect(isMlGame(game)).toBe(true);
  });
```

Append a new describe block:

```ts
describe("bot games", () => {
  async function createBotGame() {
    return createGame(db, { play_against_ml: true });
  }

  it("bot answers player 1's trio and completes the round", async () => {
    const created = await createBotGame();
    let resp;
    for (const m of ["a1b", "a1d", "b1e"]) {
      resp = await submitMove(db, {
        game_guid: created.game_guid,
        move: m,
        secret: created.secret,
        player: 1,
      });
    }
    expect(resp!.player_2_move_count).toBe(3);
    expect(resp!.round_complete).toBe(true);
    expect(resp!.completed_rounds).toBe(1);
  });

  it("does not move the bot before player 1 finishes the trio", async () => {
    const created = await createBotGame();
    const resp = await submitMove(db, {
      game_guid: created.game_guid,
      move: "a1b",
      secret: created.secret,
      player: 1,
    });
    expect(resp.player_2_move_count).toBe(0);
  });

  it("get_moves polling does not duplicate bot moves", async () => {
    const created = await createBotGame();
    for (const m of ["a1b", "a1d", "b1e"]) {
      await submitMove(db, {
        game_guid: created.game_guid,
        move: m,
        secret: created.secret,
        player: 1,
      });
    }
    const q = { game_guid: created.game_guid, secret: created.secret, player: 1 };
    const first = await getMoves(db, q);
    const second = await getMoves(db, q);
    expect(first.player_2_move_count).toBe(3);
    expect(second.player_2_move_count).toBe(3);
  });

  it("supports multiple rounds", async () => {
    const created = await createBotGame();
    const trios = ["a1b", "a1d", "b1e", "a1b", "a1d", "d1e"];
    for (const m of trios) {
      await submitMove(db, {
        game_guid: created.game_guid,
        move: m,
        secret: created.secret,
        player: 1,
      });
    }
    const resp = await getMoves(db, {
      game_guid: created.game_guid,
      secret: created.secret,
      player: 1,
    });
    expect(resp.player_2_move_count).toBe(6);
    expect(resp.completed_rounds).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS=--experimental-sqlite npx vitest run test/actions.test.ts`
Expected: FAIL — createGame still throws `"Play against ML is not yet supported"`.

- [ ] **Step 3: Update `src/actions.ts`**

Add imports:

```ts
import { planBotTrio } from "./bot";
```

and add `getMlRoundContext` to the existing `./db` import list.

REPLACE `createGame` with:

```ts
export async function createGame(
  d1: D1Database,
  body: Record<string, unknown>
): Promise<ResponseContent> {
  const playAgainstMl = parseBool(body.play_against_ml);
  const game: Game = {
    gameGuid: crypto.randomUUID(),
    player1Secret: crypto.randomUUID(),
    player2Secret: playAgainstMl
      ? `${ML_BOT_SECRET_PREFIX}:${crypto.randomUUID()}`
      : "",
  };
  await writeGame(d1, game);
  return {
    game_guid: game.gameGuid,
    secret: game.player1Secret,
    html: new Board().toHtmlTable(),
    play_against_ml: playAgainstMl,
  };
}
```

Add (port of Python `_generate_ml_moves_if_needed`; write-only-missing keeps polling idempotent):

```ts
async function generateMlMovesIfNeeded(
  d1: D1Database,
  gameGuid: string,
  rs: RoundState
): Promise<RoundState> {
  while (!rs.board.winner && rs.p1Count % 3 === 0 && rs.p1Count > rs.p2Count) {
    const roundIndex = Math.floor(rs.p2Count / 3);
    if (rs.p1Count < (roundIndex + 1) * 3) break;

    const { board, botMovesInRound } = await getMlRoundContext(
      d1,
      gameGuid,
      roundIndex
    );
    const planned = planBotTrio(board, gameGuid, roundIndex);
    const pending = planned.slice(Math.min(botMovesInRound.length, 3));
    if (pending.length === 0) break;

    for (const moveStr of pending) {
      rs = await saveMove(d1, gameGuid, new Move(moveStr), 2);
    }
  }
  return rs;
}
```

In `submitMove`, change the save/return tail to:

```ts
  const move = new Move(moveStr);
  let rs = await saveMove(d1, gameGuid, move, Number(player));
  if (playAgainstMl && String(player) === "1") {
    rs = await generateMlMovesIfNeeded(d1, gameGuid, rs);
  }
  return roundStateResponse(gameGuid, secret, playAgainstMl, rs);
```

In `getMoves`, change the tail to:

```ts
  const playAgainstMl = isMlGame(game);
  let rs = await getBoardAndRoundState(d1, gameGuid);
  if (playAgainstMl && String(player) === "1") {
    rs = await generateMlMovesIfNeeded(d1, gameGuid, rs);
  }
  return roundStateResponse(gameGuid, secret, playAgainstMl, rs);
```

- [ ] **Step 4: Run the actions suite**

Run: `NODE_OPTIONS=--experimental-sqlite npx vitest run test/actions.test.ts`
Expected: PASS (15 tests).

- [ ] **Step 5: Commit**

```bash
git add src/actions.ts test/actions.test.ts
git commit -m "feat: wire search bot into create_game/submit_move/get_moves"
```

---

### Task 7: Integration + frontend

**Files:**
- Modify: `test/integration.test.ts`, `public/index.html`

- [ ] **Step 1: Update integration tests**

In `test/integration.test.ts`, REPLACE the test `"returns 400 for play_against_ml (v1 bot seam)"` with:

```ts
  it("plays a bot game over HTTP", async () => {
    const created = (await (
      await api({ action: "create_game", play_against_ml: true })
    ).json()) as any;
    expect(created.play_against_ml).toBe(true);

    let last: any;
    for (const move of ["a1b", "a1d", "b1e"]) {
      const resp = await api({
        action: "submit_move",
        game_guid: created.game_guid,
        move,
        secret: created.secret,
        player: 1,
      });
      expect(resp.status).toBe(200);
      last = await resp.json();
    }
    expect(last.player_2_move_count).toBe(3);
    expect(last.round_complete).toBe(true);
  });
```

- [ ] **Step 2: Unhide the bot checkbox**

In `public/index.html`, revert the v1 hide (keep the comment removal too):

```html
<!-- before -->
<!-- bot returns in v2 (see design spec, "ML bot seam") -->
<div class="mode-toggle" style="display:none">
<!-- after -->
<div class="mode-toggle">
```

- [ ] **Step 3: Full suite + typecheck**

Run: `npm test && npx tsc`
Expected: all suites PASS, no type errors.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: enable bot games end-to-end (frontend toggle + integration test)"
```

---

### Task 8: Deploy + production smoke

- [ ] **Step 1: Deploy**

```bash
npx wrangler deploy
```

Expected: deploy succeeds, route `allsfair.hightower.space` printed.

- [ ] **Step 2: Smoke-test a bot game in production**

Python (urllib needs a UA or Cloudflare 1010-blocks it):

```python
# scratchpad/bot_smoke.py
import json, urllib.request

API = "https://allsfair.hightower.space/api"

def api(body):
    req = urllib.request.Request(
        API, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "curl/8.0"},
        method="POST")
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

created = api({"action": "create_game", "play_against_ml": True})
assert created["play_against_ml"] is True
for m in ["a1b", "a1d", "b1e"]:
    last = api({"action": "submit_move", "game_guid": created["game_guid"],
                "move": m, "secret": created["secret"], "player": 1})
print("p2 moves:", last["player_2_move_count"],
      "round_complete:", last["round_complete"])
assert last["player_2_move_count"] == 3 and last["round_complete"] is True
print("bot game OK")
```

Expected: `p2 moves: 3 round_complete: True` / `bot game OK`. Also load the site in a browser, tick "Play against bot (ML)", play a round.

- [ ] **Step 3: Push**

```bash
git push origin main
```

## Self-Review Notes

- Spec coverage: brain incl. all weights/params (T3), determinism (T1+T3 tests), engine helpers (T2), round context (T5), wiring + idempotency + guards (T6, guards already tested in existing suite), frontend (T7), strength gates (T4), constants-vs-BFS test (T3), deploy smoke (T8). Out-of-scope items untouched.
- v1 400-behavior tests replaced explicitly in T6/T7 per Global Constraints.
- Type consistency: `CandidateAction` defined once (T3); `RoundState` from db.ts reused; `planBotTrio(board, gameGuid, completedRounds)` signature identical in T3 def and T6 use; `getMlRoundContext` return `{board, botMovesInRound}` consistent T5/T6.
