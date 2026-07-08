# Cloudflare Worker Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reimplement the allsfair serving path (engine + 4-action API + frontend) as a TypeScript Cloudflare Worker with D1, in a new `allsfair-worker/` directory, per the spec at `allsfair-python-function/docs/superpowers/specs/2026-07-06-cloudflare-migration-design.md`.

**Architecture:** One Worker serves static assets (`public/index.html`) and `POST /api`. `src/engine.ts` is a faithful port of the Python engine (`allsfair/models.py`); `src/db.ts` ports `bq.py`+`db.py` onto D1; `src/actions.ts` ports `actions.py` (ML bot seam kept, bot itself returns 400 in v1). Python engine stays source of truth — a fixture generator in the `allsfair` repo produces parity fixtures the TS test suite replays.

**Tech Stack:** TypeScript, Cloudflare Workers + D1 + static assets, wrangler v4, vitest 3 + @cloudflare/vitest-pool-workers.

## Global Constraints

- New top-level directory: `/Users/floyd/code/allsfair/allsfair-worker/` — its own git repo (parent dir is not a repo).
- JSON response field names stay snake_case, exactly matching the Python `ResponseContent`: `game_guid`, `secret`, `html`, `play_against_ml`, `player_1_move_count`, `player_2_move_count`, `completed_rounds`, `round_complete`.
- Error responses: plain-text body, status 400, message text identical to the Python exceptions (frontend displays raw text).
- HTML output of `toHtmlTable()` must be byte-identical to Python `Board.to_html_table()` (verified by parity fixtures).
- ML bot seam preserved: `ML_BOT_SECRET_PREFIX = "__ML_BOT__"`, `isMlGame()`, ML guard checks in `join_game`/`submit_move`; `create_game` with `play_against_ml` truthy → 400 `"Play against ML is not yet supported"`.
- One documented behavior deviation: a move referencing an unknown square (e.g. `z1a`) throws `InvalidMove` (Python crashed with `KeyError` → 500).
- Node v23 / npm 11 already installed on this machine.
- All engine code: no `Date.now()`, no I/O — pure functions of input (mirrors Python).

## File Structure

```
allsfair-worker/
├── package.json, tsconfig.json, vitest.config.ts, wrangler.toml, .gitignore
├── migrations/0001_init.sql        # D1 schema (used by deploy AND tests)
├── public/index.html               # moved from allsfair-python-function/frontend/
├── src/
│   ├── exceptions.ts               # port of allsfair/exceptions.py
│   ├── engine.ts                   # port of allsfair/models.py
│   ├── errors.ts                   # ActionError (user-facing 400s)
│   ├── db.ts                       # port of bq.py + db.py (D1)
│   ├── actions.ts                  # port of actions.py
│   └── index.ts                    # fetch handler / action router
└── test/
    ├── env.d.ts, apply-migrations.ts
    ├── engine.move.test.ts
    ├── engine.board.test.ts
    ├── parity.test.ts + fixtures/parity.json
    ├── db.test.ts
    ├── actions.test.ts
    └── integration.test.ts

allsfair/ (existing Python repo — one addition)
└── scripts/generate_parity_fixtures.py
```

---

### Task 1: Scaffold the worker project

**Files:**
- Create: `allsfair-worker/package.json`, `tsconfig.json`, `wrangler.toml`, `vitest.config.ts`, `.gitignore`, `migrations/0001_init.sql`, `test/env.d.ts`, `test/apply-migrations.ts`, `src/index.ts` (stub)

**Interfaces:**
- Produces: `Env` interface `{ DB: D1Database }` in `src/index.ts`; D1 tables `games`, `moves`; test harness where `env.DB` is a migrated D1 database and `SELF` targets `src/index.ts`.

- [ ] **Step 1: Create directory, git init, npm install**

```bash
mkdir -p /Users/floyd/code/allsfair/allsfair-worker
cd /Users/floyd/code/allsfair/allsfair-worker
git init
npm init -y
npm install -D typescript wrangler vitest@~3.2.0 @cloudflare/vitest-pool-workers @cloudflare/workers-types
```

- [ ] **Step 2: Write config files**

`package.json` — replace the generated one with:

```json
{
  "name": "allsfair-worker",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {}
}
```

(then re-run the `npm install -D ...` from Step 1 if the devDependencies were lost by overwriting — the lockfile keeps versions).

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "es2022",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "lib": ["es2022"],
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"]
  },
  "include": ["src", "test"]
}
```

`wrangler.toml` (dummy `database_id` until the deploy task creates the real one):

```toml
name = "allsfair"
main = "src/index.ts"
compatibility_date = "2026-07-01"

[assets]
directory = "./public"

[[d1_databases]]
binding = "DB"
database_name = "allsfair"
database_id = "00000000-0000-0000-0000-000000000000"
```

`vitest.config.ts`:

```ts
import path from "node:path";
import {
  defineWorkersConfig,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          main: "./src/index.ts",
          wrangler: { configPath: "./wrangler.toml" },
          miniflare: {
            bindings: { TEST_MIGRATIONS: migrations },
          },
        },
      },
    },
  };
});
```

`.gitignore`:

```
node_modules/
.wrangler/
```

`migrations/0001_init.sql`:

```sql
CREATE TABLE games (
  game_guid        TEXT PRIMARY KEY,
  player_1_secret  TEXT NOT NULL,
  player_2_secret  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE moves (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  game_guid   TEXT NOT NULL,
  move_string TEXT NOT NULL,
  player      INTEGER NOT NULL
);

CREATE INDEX idx_moves_game ON moves(game_guid, id);
```

`test/apply-migrations.ts`:

```ts
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

`test/env.d.ts`:

```ts
import type { Env } from "../src/index";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}
```

`public/.gitkeep`: empty file (assets dir must exist for wrangler config to validate; the real index.html arrives in Task 8).

- [ ] **Step 3: Write stub worker + smoke test**

`src/index.ts`:

```ts
export interface Env {
  DB: D1Database;
}

export default {
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

`test/smoke.test.ts`:

```ts
import { env } from "cloudflare:test";
import { expect, it } from "vitest";

it("has a migrated D1 database", async () => {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('games','moves') ORDER BY name"
  ).all<{ name: string }>();
  expect(results.map((r) => r.name)).toEqual(["games", "moves"]);
});
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS (1 test) — proves the workers pool, migrations, and D1 binding all work.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold Cloudflare Worker project with D1 test harness"
```

---

### Task 2: Engine — exceptions, Move, MovePair

**Files:**
- Create: `src/exceptions.ts`, `src/engine.ts` (Move/MovePair portion)
- Test: `test/engine.move.test.ts`

**Interfaces:**
- Produces:
  - `exceptions.ts`: `BaseAllsfairError`, `ImproperlyFormattedMove(moveStr)`, `InvalidMove(moveStr)`, `InvalidSecret()` — all extend `Error` via `BaseAllsfairError`, message texts identical to Python.
  - `engine.ts`: `TEAM_1 = 1`, `TEAM_2 = 2`, `TEAM_1_HOME_SQUARE = "a"`, `TEAM_2_HOME_SQUARE = "i"`, `interface NodeState { neighbors: string[]; owner: number; troopCount: number }`, `type BoardState = Record<string, NodeState>`, `startingBoardState(): BoardState`, `class Move { start; troopCount; end; constructor(moveStr: string); toString(): string }`, `class MovePair { team1Move: Move; team2Move: Move; isSwap: boolean; isCollision: boolean; constructor(team1Move, team2Move) }`.

- [ ] **Step 1: Write the failing test**

`test/engine.move.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/engine.move.test.ts`
Expected: FAIL — cannot resolve `../src/engine` / `../src/exceptions`.

- [ ] **Step 3: Write the implementation**

`src/exceptions.ts` (port of `allsfair/exceptions.py`):

```ts
export const PROPER_MOVE_GUIDE =
  "A valid move must have the form: {STARTING SQUARE}{TROOP COUNT}{ENDING SQUARE} like 'a1b' or 'i42h'.";

export class BaseAllsfairError extends Error {}

export class ImproperlyFormattedMove extends BaseAllsfairError {
  constructor(moveStr: string) {
    super(`Improperly formatted move: '${moveStr}'. ${PROPER_MOVE_GUIDE}`);
  }
}

export class InvalidMove extends BaseAllsfairError {
  constructor(moveStr: string) {
    super(`Invalid move: '${moveStr}'.`);
  }
}

export class InvalidSecret extends BaseAllsfairError {
  constructor() {
    super("Invalid secret");
  }
}
```

`src/engine.ts` (first portion — Board comes in Task 3):

```ts
import { ImproperlyFormattedMove, InvalidMove } from "./exceptions";

export const TEAM_1 = 1;
export const TEAM_2 = 2;
export const TEAM_1_HOME_SQUARE = "a";
export const TEAM_2_HOME_SQUARE = "i";

export interface NodeState {
  neighbors: string[];
  owner: number;
  troopCount: number;
}

export type BoardState = Record<string, NodeState>;

// Key order matters: Object.entries() iterates a..i, which drives the 3-per-row
// HTML layout exactly like the Python dict.
export function startingBoardState(): BoardState {
  return {
    a: { neighbors: ["b", "d"], owner: TEAM_1, troopCount: 3 },
    b: { neighbors: ["a", "c", "e"], owner: 0, troopCount: 0 },
    c: { neighbors: ["b", "f"], owner: 0, troopCount: 0 },
    d: { neighbors: ["a", "e", "g"], owner: 0, troopCount: 0 },
    e: { neighbors: ["b", "d", "f", "h"], owner: 0, troopCount: 0 },
    f: { neighbors: ["c", "e", "i"], owner: 0, troopCount: 0 },
    g: { neighbors: ["d", "h"], owner: 0, troopCount: 0 },
    h: { neighbors: ["e", "g", "i"], owner: 0, troopCount: 0 },
    i: { neighbors: ["f", "h"], owner: TEAM_2, troopCount: 3 },
  };
}

const ADJACENCY: BoardState = startingBoardState();

export class Move {
  start: string;
  troopCount: number;
  end: string;

  constructor(moveStr: string) {
    const match = /^([A-Za-z]+)(\d+)([A-Za-z]+)/.exec(moveStr);
    if (!match) throw new ImproperlyFormattedMove(moveStr);
    this.start = match[1];
    this.troopCount = parseInt(match[2], 10);
    this.end = match[3];
    if (!this.isMoveValid()) throw new InvalidMove(moveStr);
  }

  isMoveValid(): boolean {
    const node = ADJACENCY[this.start];
    if (!node) return false; // unknown square: InvalidMove, not a crash
    return node.neighbors.includes(this.end);
  }

  toString(): string {
    return `${this.start}${this.troopCount}${this.end}`;
  }
}

export class MovePair {
  team1Move: Move;
  team2Move: Move;
  isSwap: boolean;
  isCollision: boolean;

  constructor(team1Move: Move, team2Move: Move) {
    this.team1Move = team1Move;
    this.team2Move = team2Move;
    this.isSwap =
      team1Move.end === team2Move.start && team2Move.end === team1Move.start;
    this.isCollision = team1Move.end === team2Move.end;
  }

  toString(): string {
    return `${this.team1Move} + ${this.team2Move}`;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/engine.move.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/exceptions.ts src/engine.ts test/engine.move.test.ts
git commit -m "feat: port Move, MovePair, and engine exceptions to TypeScript"
```

---

### Task 3: Engine — Board

**Files:**
- Modify: `src/engine.ts` (append Board)
- Test: `test/engine.board.test.ts`

**Interfaces:**
- Consumes: `Move`, `MovePair`, `startingBoardState`, team constants from Task 2.
- Produces: `class Board { state: BoardState; startingState: BoardState; history: HistoryEntry[]; applyMovePair(moves: MovePair): BoardState; restock(): void; get winner(): number; populatedSquaresOwned(team: number): string[]; toHtmlTable(): string }` and `interface HistoryEntry { state: BoardState; team1MoveStr: string; team2MoveStr: string }`.
- Port notes (rule-critical, from `models.py`):
  - `applyMovePair` MUTATES the passed moves' `troopCount` (clamping, zeroing, swap/collision residuals) — exactly like Python.
  - History snapshots capture state AND move strings at insert time (Python deepcopies the mutated `MovePair`), newest first.
  - Equal swap/collision: both sides lose their troops, snapshot, early return.
  - `restock()` computes squares owned (including empty squares) BEFORE the winner check, adds that count to each team's home square if still owned; no-op when a winner exists. Python's `print()` is dropped.

- [ ] **Step 1: Write the failing test**

`test/engine.board.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Board, Move, MovePair } from "../src/engine";

function pair(p1: string, p2: string): MovePair {
  return new MovePair(new Move(p1), new Move(p2));
}

describe("Board basics", () => {
  it("starts with 3 troops on each home square", () => {
    const board = new Board();
    expect(board.state.a).toMatchObject({ owner: 1, troopCount: 3 });
    expect(board.state.i).toMatchObject({ owner: 2, troopCount: 3 });
    expect(board.winner).toBe(0);
  });

  it("moves troops and captures empty squares", () => {
    const board = new Board();
    board.applyMovePair(pair("a2b", "i2h"));
    expect(board.state.a.troopCount).toBe(1);
    expect(board.state.b).toMatchObject({ owner: 1, troopCount: 2 });
    expect(board.state.h).toMatchObject({ owner: 2, troopCount: 2 });
  });

  it("clamps a move to available troops", () => {
    const board = new Board();
    board.applyMovePair(pair("a9b", "i1h"));
    expect(board.state.a.troopCount).toBe(0);
    expect(board.state.b.troopCount).toBe(3);
  });

  it("zeroes a move from a square the team does not own", () => {
    const board = new Board();
    board.applyMovePair(pair("b1e", "i1h"));
    expect(board.state.b.troopCount).toBe(0);
    expect(board.state.e).toMatchObject({ owner: 0, troopCount: 0 });
    expect(board.state.h).toMatchObject({ owner: 2, troopCount: 1 });
  });
});

describe("combat", () => {
  it("equal collision destroys both forces", () => {
    const board = new Board();
    board.applyMovePair(pair("a3b", "i3h"));
    board.applyMovePair(pair("b3e", "h3e"));
    expect(board.state.b.troopCount).toBe(0);
    expect(board.state.h.troopCount).toBe(0);
    expect(board.state.e).toMatchObject({ owner: 0, troopCount: 0 });
  });

  it("unequal collision leaves the larger force's residual", () => {
    const board = new Board();
    board.applyMovePair(pair("a3b", "i2h"));
    board.applyMovePair(pair("b3e", "h2e"));
    expect(board.state.e).toMatchObject({ owner: 1, troopCount: 1 });
  });

  it("unequal swap conquers the smaller force's square", () => {
    const board = new Board();
    board.applyMovePair(pair("a3b", "i3f"));
    board.applyMovePair(pair("b3e", "f1i"));
    board.applyMovePair(pair("e3f", "f2e")); // swap: 3 vs 2 -> P1 residual 1 into f
    expect(board.state.f).toMatchObject({ owner: 1, troopCount: 1 });
    expect(board.state.e).toMatchObject({ owner: 1, troopCount: 0 });
  });

  it("attacking a defended square subtracts troops and flips owner on overrun", () => {
    const board = new Board();
    board.applyMovePair(pair("a3b", "i1h"));
    board.applyMovePair(pair("b3e", "i1h"));
    board.applyMovePair(pair("e3h", "i1f")); // 3 attack h defended by 2 -> owner flips, 1 remains
    expect(board.state.h).toMatchObject({ owner: 1, troopCount: 1 });
  });
});

describe("winner and restock", () => {
  it("declares team 2 winner when team 1 base is taken and team 1 has no populated squares", () => {
    const board = new Board();
    board.state.a.owner = 2;
    board.state.a.troopCount = 1;
    expect(board.winner).toBe(2);
  });

  it("declares team 1 winner when team 2 base is taken and team 2 has no populated squares", () => {
    const board = new Board();
    board.state.i.owner = 1;
    expect(board.winner).toBe(1);
  });

  it("restocks home squares by number of owned squares", () => {
    const board = new Board();
    board.applyMovePair(pair("a1b", "i1h"));
    board.restock();
    expect(board.state.a.troopCount).toBe(4); // 2 left + 2 squares owned
    expect(board.state.i.troopCount).toBe(4);
  });

  it("does not restock once a winner exists", () => {
    const board = new Board();
    board.state.i.owner = 1;
    board.restock();
    expect(board.state.a.troopCount).toBe(3);
  });
});

describe("history and html", () => {
  it("records post-move snapshots newest-first", () => {
    const board = new Board();
    board.applyMovePair(pair("a1b", "i1h"));
    board.applyMovePair(pair("a1d", "i1f"));
    expect(board.history).toHaveLength(2);
    expect(board.history[0].team1MoveStr).toBe("a1d");
    expect(board.history[1].state.b.troopCount).toBe(1);
  });

  it("snapshots are not mutated by later moves", () => {
    const board = new Board();
    board.applyMovePair(pair("a1b", "i1h"));
    const snapshot = board.history[0].state;
    board.applyMovePair(pair("a1b", "i1h"));
    expect(snapshot.b.troopCount).toBe(1);
  });

  it("history records the mutated move (clamped count)", () => {
    const board = new Board();
    board.applyMovePair(pair("a9b", "i1h"));
    expect(board.history[0].team1MoveStr).toBe("a3b");
  });

  it("renders board, history, and style block", () => {
    const board = new Board();
    board.applyMovePair(pair("a2b", "i2h"));
    const html = board.toHtmlTable();
    expect(html).toContain("<td class='player1'>a: 1</td>");
    expect(html).toContain("Starting board");
    expect(html).toContain("Moves: P1 a2b, P2 i2h");
    expect(html).toContain("<summary>History</summary>");
    expect(html).toContain("<style>");
  });

  it("shows the winner banner", () => {
    const board = new Board();
    board.state.i.owner = 1;
    expect(board.toHtmlTable()).toContain(
      "Winner is team <span class='player1'>1</span>"
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/engine.board.test.ts`
Expected: FAIL — `Board` not exported.

- [ ] **Step 3: Append Board to `src/engine.ts`**

```ts
export interface HistoryEntry {
  state: BoardState;
  team1MoveStr: string;
  team2MoveStr: string;
}

// Byte-identical to the trailing triple-quoted string in Python
// Board.to_html_table (leading newline, 8-space indent, trailing
// newline + 8 spaces). Parity fixtures compare full HTML output.
const STYLE_BLOCK = `
        <style>
            table {
                border-collapse: collapse;
            }
            td {
                border: 1px solid black;
                padding: 8px;
            }
            .player1 {
                background-color: #39FF14;
            }
            .player2 {
                background-color: #FF142A;
                color: white;
            }
            .move-pair {
                margin: 4px 0 10px 0;
                font-family: monospace;
            }
        </style>
        `;

export class Board {
  state: BoardState;
  startingState: BoardState;
  history: HistoryEntry[];

  constructor() {
    this.state = startingBoardState();
    this.startingState = structuredClone(this.state);
    this.history = [];
  }

  private stateToHtmlTable(state: BoardState): string {
    let s = "<table>";
    const entries = Object.entries(state);
    for (let i = 0; i < entries.length; i += 3) {
      s += "<tr>";
      for (const [name, node] of entries.slice(i, i + 3)) {
        s += `<td class='player${node.owner}'>${name}: ${node.troopCount}</td>`;
      }
      s += "</tr>";
    }
    s += "</table>";
    return s;
  }

  private historyToHtml(): string {
    let s = this.stateToHtmlTable(this.startingState);
    s += "<div class='move-pair'>Starting board</div><br>";
    for (const entry of [...this.history].reverse()) {
      s += this.stateToHtmlTable(entry.state);
      s += `<div class='move-pair'>Moves: P1 ${entry.team1MoveStr}, P2 ${entry.team2MoveStr}</div><br>`;
    }
    return s;
  }

  toHtmlTable(): string {
    let s = "";
    const winner = this.winner;
    if (winner) {
      s += `Winner is team <span class='player${winner}'>${winner}</span>`;
    }
    s += this.stateToHtmlTable(this.state);
    s += "<br><details>";
    s += "<summary>History</summary>";
    s += this.historyToHtml();
    s += "</details>";
    s += STYLE_BLOCK;
    return s;
  }

  private isMovePossible(move: Move, team: number): boolean {
    const startingNode = this.state[move.start];
    if (startingNode.owner !== team) return false;
    if (move.troopCount > startingNode.troopCount) {
      // Requesting more than the square holds moves everything in it
      move.troopCount = startingNode.troopCount;
    }
    return true;
  }

  private removeTroopsFromStart(move: Move): void {
    this.state[move.start].troopCount -= move.troopCount;
  }

  private applyMove(move: Move, team: number): void {
    if (move.troopCount < 1) return;
    const destination = this.state[move.end];
    if (destination.owner === team || destination.owner === 0) {
      destination.owner = team;
      destination.troopCount += move.troopCount;
    } else {
      destination.troopCount -= move.troopCount;
      if (destination.troopCount < 0) {
        destination.owner = team;
        destination.troopCount = Math.abs(destination.troopCount);
      }
    }
  }

  private snapshot(moves: MovePair): void {
    this.history.unshift({
      state: structuredClone(this.state),
      team1MoveStr: moves.team1Move.toString(),
      team2MoveStr: moves.team2Move.toString(),
    });
  }

  applyMovePair(moves: MovePair): BoardState {
    if (!this.isMovePossible(moves.team1Move, TEAM_1)) {
      moves.team1Move.troopCount = 0;
    }
    if (!this.isMovePossible(moves.team2Move, TEAM_2)) {
      moves.team2Move.troopCount = 0;
    }

    this.removeTroopsFromStart(moves.team1Move);
    this.removeTroopsFromStart(moves.team2Move);

    if (moves.isSwap || moves.isCollision) {
      // Only the move with the greater troop count survives
      if (moves.team1Move.troopCount === moves.team2Move.troopCount) {
        this.snapshot(moves);
        return this.state;
      } else if (moves.team1Move.troopCount > moves.team2Move.troopCount) {
        moves.team1Move.troopCount -= moves.team2Move.troopCount;
        moves.team2Move.troopCount = 0;
      } else {
        moves.team2Move.troopCount -= moves.team1Move.troopCount;
        moves.team1Move.troopCount = 0;
      }
    }

    this.applyMove(moves.team1Move, TEAM_1);
    this.applyMove(moves.team2Move, TEAM_2);
    this.snapshot(moves);
    return this.state;
  }

  private squaresOwned(team: number): number {
    return Object.values(this.state).filter((n) => n.owner === team).length;
  }

  populatedSquaresOwned(team: number): string[] {
    return Object.entries(this.state)
      .filter(([, node]) => node.owner === team && node.troopCount > 0)
      .map(([name]) => name);
  }

  get winner(): number {
    const team1BaseTaken = this.state[TEAM_1_HOME_SQUARE].owner === TEAM_2;
    const team2BaseTaken = this.state[TEAM_2_HOME_SQUARE].owner === TEAM_1;

    const team1SquaresOwned = this.populatedSquaresOwned(TEAM_1).length;
    const team2SquaresOwned = this.populatedSquaresOwned(TEAM_2).length;

    if (team2BaseTaken && team2SquaresOwned === 0) return TEAM_1;
    if (team1BaseTaken && team1SquaresOwned === 0) return TEAM_2;
    return 0;
  }

  /** To be called after all move pairs of a round are applied. */
  restock(): void {
    const team1SquaresOwned = this.squaresOwned(TEAM_1);
    const team2SquaresOwned = this.squaresOwned(TEAM_2);

    if (this.winner) return;

    if (this.state[TEAM_1_HOME_SQUARE].owner === TEAM_1) {
      this.state[TEAM_1_HOME_SQUARE].troopCount += team1SquaresOwned;
    }
    if (this.state[TEAM_2_HOME_SQUARE].owner === TEAM_2) {
      this.state[TEAM_2_HOME_SQUARE].troopCount += team2SquaresOwned;
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/engine.board.test.ts test/engine.move.test.ts`
Expected: PASS. If a combat assertion fails, re-check against the Python semantics in the Interfaces block — the Python code is the spec, not the test.

- [ ] **Step 5: Commit**

```bash
git add src/engine.ts test/engine.board.test.ts
git commit -m "feat: port Board (move resolution, combat, winner, restock, html) to TypeScript"
```

---

### Task 4: Parity fixtures — Python generator + TS replay test

**Files:**
- Create: `/Users/floyd/code/allsfair/allsfair/scripts/generate_parity_fixtures.py` (in the Python engine repo)
- Create: `allsfair-worker/test/fixtures/parity.json` (generated, committed)
- Test: `allsfair-worker/test/parity.test.ts`

**Interfaces:**
- Consumes: TS `Board`, `Move`, `MovePair` from Tasks 2–3; Python engine from the `allsfair` repo.
- Produces: fixture JSON — an array of `{ name: string, pairs: [string, string][], states: Record<string, [number, number]>[], winner: number, final_html: string }` where `states[k]` is the board after pair `k+1` (restock applied after every 3rd pair) and each square maps to `[owner, troopCount]`.

- [ ] **Step 1: Write the generator**

`/Users/floyd/code/allsfair/allsfair/scripts/generate_parity_fixtures.py`:

```python
"""Generate parity fixtures for the TypeScript engine port.

Replays scripted and seeded-random games through the Python engine and
records the board after every move pair, so the TS port can assert
byte-identical behavior (including final HTML).

Usage:
    uv run python scripts/generate_parity_fixtures.py ../allsfair-worker/test/fixtures/parity.json
"""

import json
import random
import sys
from pathlib import Path

from allsfair.models import (
    TEAM_1_DESIGNATION,
    TEAM_2_DESIGNATION,
    Board,
    Move,
    MovePair,
    starting_board,
)

SCRIPTED_SCENARIOS = {
    "opening_march": [("a2b", "i2h"), ("b2e", "h2e"), ("a1d", "i1f")],
    "clamp_and_zeroed_origin": [("a9b", "b1e"), ("b3c", "i9h"), ("c1f", "h9e")],
    "swap_unequal": [("a3b", "i3f"), ("b3e", "f1i"), ("e3f", "f2e")],
}


def serialize_state(state) -> dict:
    return {name: [node.owner, node.troop_count] for name, node in state.items()}


def replay(pairs):
    """Replay move-pair strings exactly like db.py: restock after every 3rd pair."""
    board = Board()
    states = []
    for idx, (p1, p2) in enumerate(pairs, start=1):
        board.apply_move_pair(MovePair(Move(p1), Move(p2)))
        if idx % 3 == 0:
            board.restock()
        states.append(serialize_state(board.state))
    return board, states


def random_move(rng: random.Random, board: Board, team: int) -> str:
    owned = board.populated_squares_owned(team)
    if not owned:
        home = "a" if team == TEAM_1_DESIGNATION else "i"
        return f"{home}1{starting_board[home].neighbors[0]}"
    start = rng.choice(owned)
    end = rng.choice(starting_board[start].neighbors)
    # Over-request sometimes to exercise clamping
    count = rng.randint(1, board.state[start].troop_count + 2)
    return f"{start}{count}{end}"


def random_playout(seed: int, max_rounds: int) -> list[tuple[str, str]]:
    rng = random.Random(seed)
    board = Board()
    pairs = []
    for _ in range(max_rounds):
        for _ in range(3):
            p1 = random_move(rng, board, TEAM_1_DESIGNATION)
            p2 = random_move(rng, board, TEAM_2_DESIGNATION)
            pairs.append((p1, p2))
            board.apply_move_pair(MovePair(Move(p1), Move(p2)))
        board.restock()
        if board.winner:
            break
    return pairs


def main(output_path: str) -> None:
    scenarios = dict(SCRIPTED_SCENARIOS)
    for seed in (1, 2, 3, 4, 5):
        scenarios[f"seeded_playout_{seed}"] = random_playout(seed, max_rounds=20)

    fixtures = []
    for name, pairs in scenarios.items():
        board, states = replay(pairs)
        fixtures.append(
            {
                "name": name,
                "pairs": [list(p) for p in pairs],
                "states": states,
                "winner": board.winner,
                "final_html": board.to_html_table(),
            }
        )

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(fixtures, indent=2))
    print(f"Wrote {len(fixtures)} scenarios to {out}")


if __name__ == "__main__":
    main(sys.argv[1])
```

- [ ] **Step 2: Generate fixtures**

```bash
cd /Users/floyd/code/allsfair/allsfair
uv run python scripts/generate_parity_fixtures.py ../allsfair-worker/test/fixtures/parity.json
```

Expected: `Wrote 8 scenarios to ../allsfair-worker/test/fixtures/parity.json`. Sanity-check the JSON: 8 entries, seeded playouts have dozens of pairs, `final_html` starts with `<table>` or `Winner is team`.

- [ ] **Step 3: Write the TS replay test**

`allsfair-worker/test/parity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Board, Move, MovePair } from "../src/engine";
import fixtures from "./fixtures/parity.json";

interface Scenario {
  name: string;
  pairs: [string, string][];
  states: Record<string, [number, number]>[];
  winner: number;
  final_html: string;
}

function serializeState(board: Board): Record<string, [number, number]> {
  return Object.fromEntries(
    Object.entries(board.state).map(([name, node]) => [
      name,
      [node.owner, node.troopCount],
    ])
  );
}

describe("parity with the Python engine", () => {
  for (const scenario of fixtures as Scenario[]) {
    it(`replays ${scenario.name} identically`, () => {
      const board = new Board();
      scenario.pairs.forEach(([p1, p2], idx) => {
        board.applyMovePair(new MovePair(new Move(p1), new Move(p2)));
        if ((idx + 1) % 3 === 0) board.restock();
        expect(serializeState(board), `after pair ${idx + 1}`).toEqual(
          scenario.states[idx]
        );
      });
      expect(board.winner).toBe(scenario.winner);
      expect(board.toHtmlTable()).toBe(scenario.final_html);
    });
  }
});
```

- [ ] **Step 4: Run the parity test**

Run: `cd /Users/floyd/code/allsfair/allsfair-worker && npx vitest run test/parity.test.ts`
Expected: PASS (8 tests). Any failure is a port bug — diff the first mismatching pair index against `models.py` behavior and fix `engine.ts` (never the fixture).

- [ ] **Step 5: Commit both repos**

```bash
cd /Users/floyd/code/allsfair/allsfair
git add scripts/generate_parity_fixtures.py
git commit -m "feat: add parity fixture generator for TypeScript engine port"

cd /Users/floyd/code/allsfair/allsfair-worker
git add test/fixtures/parity.json test/parity.test.ts
git commit -m "test: verify engine parity against Python-generated fixtures"
```

---

### Task 5: D1 data layer

**Files:**
- Create: `src/errors.ts`, `src/db.ts`
- Test: `test/db.test.ts`

**Interfaces:**
- Consumes: `Board`, `Move`, `MovePair` from engine; D1 tables from Task 1.
- Produces (all consumed by Task 6):
  - `errors.ts`: `class ActionError extends Error` — any error the router maps to a 400.
  - `db.ts`: `interface Game { gameGuid: string; player1Secret: string; player2Secret: string }`, `interface RoundState { board: Board; p1Count: number; p2Count: number; completedRounds: number; roundComplete: boolean }`, `class GameNotFound extends ActionError`, `writeGame(db: D1Database, game: Game): Promise<void>`, `getGameByGuid(db: D1Database, gameGuid: string): Promise<Game>`, `updateGame(db: D1Database, game: Game): Promise<void>` (updates `player_2_secret` only), `writeMove(db: D1Database, gameGuid: string, move: Move, player: number): Promise<void>`, `getMovesForGuid(db: D1Database, gameGuid: string): Promise<{ moveString: string; player: number }[]>`, `getBoardAndRoundState(db: D1Database, gameGuid: string): Promise<RoundState>`, `saveMove(db: D1Database, gameGuid: string, move: Move, player: number): Promise<RoundState>`.

- [ ] **Step 1: Write the failing test**

`test/db.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  GameNotFound,
  getBoardAndRoundState,
  getGameByGuid,
  getMovesForGuid,
  saveMove,
  updateGame,
  writeGame,
  writeMove,
} from "../src/db";
import { Move } from "../src/engine";

const game = { gameGuid: "g-1", player1Secret: "s1", player2Secret: "" };

describe("games", () => {
  it("writes and reads a game", async () => {
    await writeGame(env.DB, game);
    expect(await getGameByGuid(env.DB, "g-1")).toEqual(game);
  });

  it("throws GameNotFound for an unknown guid", async () => {
    await expect(getGameByGuid(env.DB, "nope")).rejects.toBeInstanceOf(GameNotFound);
    await expect(getGameByGuid(env.DB, "nope")).rejects.toThrow(
      "No game found with guid: nope"
    );
  });

  it("updates player 2 secret", async () => {
    await writeGame(env.DB, game);
    await updateGame(env.DB, { ...game, player2Secret: "s2" });
    expect((await getGameByGuid(env.DB, "g-1")).player2Secret).toBe("s2");
  });
});

describe("moves and round state", () => {
  it("returns moves in insertion order", async () => {
    await writeMove(env.DB, "g-1", new Move("a1b"), 1);
    await writeMove(env.DB, "g-1", new Move("i1h"), 2);
    expect(await getMovesForGuid(env.DB, "g-1")).toEqual([
      { moveString: "a1b", player: 1 },
      { moveString: "i1h", player: 2 },
    ]);
  });

  it("replays the board and reports round state", async () => {
    for (const m of ["a1b", "a1d", "b1e"]) {
      await writeMove(env.DB, "g-2", new Move(m), 1);
    }
    for (const m of ["i1h", "i1f", "h1e"]) {
      await writeMove(env.DB, "g-2", new Move(m), 2);
    }
    const rs = await getBoardAndRoundState(env.DB, "g-2");
    expect(rs.p1Count).toBe(3);
    expect(rs.p2Count).toBe(3);
    expect(rs.completedRounds).toBe(1);
    expect(rs.roundComplete).toBe(true);
    // pair 3 (b1e vs h1e) is an equal collision, then restock: 3 squares each
    expect(rs.board.state.e.troopCount).toBe(0);
    expect(rs.board.state.a.troopCount).toBe(4);
    expect(rs.board.state.i.troopCount).toBe(4);
  });

  it("saveMove writes then returns fresh state", async () => {
    const rs = await saveMove(env.DB, "g-3", new Move("a1b"), 1);
    expect(rs.p1Count).toBe(1);
    expect(rs.p2Count).toBe(0);
    expect(rs.roundComplete).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/db.test.ts`
Expected: FAIL — cannot resolve `../src/db`.

- [ ] **Step 3: Write the implementation**

`src/errors.ts`:

```ts
/** Errors whose message is safe to return to the client with status 400. */
export class ActionError extends Error {}
```

`src/db.ts`:

```ts
import { Board, Move, MovePair } from "./engine";
import { ActionError } from "./errors";

export interface Game {
  gameGuid: string;
  player1Secret: string;
  player2Secret: string;
}

export interface RoundState {
  board: Board;
  p1Count: number;
  p2Count: number;
  completedRounds: number;
  roundComplete: boolean;
}

export class GameNotFound extends ActionError {
  constructor(gameGuid: string) {
    super(`No game found with guid: ${gameGuid}`);
  }
}

interface GameRow {
  game_guid: string;
  player_1_secret: string;
  player_2_secret: string;
}

export async function writeGame(db: D1Database, game: Game): Promise<void> {
  await db
    .prepare(
      "INSERT INTO games (game_guid, player_1_secret, player_2_secret) VALUES (?, ?, ?)"
    )
    .bind(game.gameGuid, game.player1Secret, game.player2Secret)
    .run();
}

export async function getGameByGuid(
  db: D1Database,
  gameGuid: string
): Promise<Game> {
  const row = await db
    .prepare(
      "SELECT game_guid, player_1_secret, player_2_secret FROM games WHERE game_guid = ?"
    )
    .bind(gameGuid)
    .first<GameRow>();
  if (!row) throw new GameNotFound(gameGuid);
  return {
    gameGuid: row.game_guid,
    player1Secret: row.player_1_secret,
    player2Secret: row.player_2_secret,
  };
}

export async function updateGame(db: D1Database, game: Game): Promise<void> {
  await db
    .prepare("UPDATE games SET player_2_secret = ? WHERE game_guid = ?")
    .bind(game.player2Secret, game.gameGuid)
    .run();
}

export async function writeMove(
  db: D1Database,
  gameGuid: string,
  move: Move,
  player: number
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO moves (game_guid, move_string, player) VALUES (?, ?, ?)"
    )
    .bind(gameGuid, move.toString(), player)
    .run();
}

export async function getMovesForGuid(
  db: D1Database,
  gameGuid: string
): Promise<{ moveString: string; player: number }[]> {
  const { results } = await db
    .prepare(
      "SELECT move_string, player FROM moves WHERE game_guid = ? ORDER BY id ASC"
    )
    .bind(gameGuid)
    .all<{ move_string: string; player: number }>();
  return results.map((r) => ({ moveString: r.move_string, player: r.player }));
}

export async function getBoardAndRoundState(
  db: D1Database,
  gameGuid: string
): Promise<RoundState> {
  const moves = await getMovesForGuid(db, gameGuid);
  const board = new Board();
  const p1Moves: Move[] = [];
  const p2Moves: Move[] = [];

  for (const m of moves) {
    (m.player === 1 ? p1Moves : p2Moves).push(new Move(m.moveString));
  }

  const pairCount = Math.min(p1Moves.length, p2Moves.length);
  for (let i = 0; i < pairCount; i++) {
    board.applyMovePair(new MovePair(p1Moves[i], p2Moves[i]));
    if ((i + 1) % 3 === 0) board.restock();
  }

  const p1Count = p1Moves.length;
  const p2Count = p2Moves.length;
  const completedRounds = Math.floor(Math.min(p1Count, p2Count) / 3);
  const roundComplete = p1Count === p2Count && p1Count > 0 && p1Count % 3 === 0;
  return { board, p1Count, p2Count, completedRounds, roundComplete };
}

export async function saveMove(
  db: D1Database,
  gameGuid: string,
  move: Move,
  player: number
): Promise<RoundState> {
  await writeMove(db, gameGuid, move, player);
  return getBoardAndRoundState(db, gameGuid);
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/db.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/errors.ts src/db.ts test/db.test.ts
git commit -m "feat: add D1 data layer (games, moves, board replay)"
```

---

### Task 6: Actions

**Files:**
- Create: `src/actions.ts`
- Test: `test/actions.test.ts`

**Interfaces:**
- Consumes: everything from `src/db.ts`, `Board`/`Move` from engine, `InvalidSecret` from exceptions, `ActionError` from errors.
- Produces (consumed by Task 7):
  - `interface ResponseContent { game_guid: string; secret: string; html: string; play_against_ml?: boolean; player_1_move_count?: number; player_2_move_count?: number; completed_rounds?: number; round_complete?: boolean }`
  - `ML_BOT_SECRET_PREFIX = "__ML_BOT__"`, `isMlGame(game: Game): boolean`
  - `createGame(d1: D1Database, body: Record<string, unknown>): Promise<ResponseContent>` — same signature for `joinGame`, `submitMove`, `getMoves`.
- Behavior deltas vs Python (intentional): secret validation reuses the already-fetched game row (Python re-queried); `create_game` with `play_against_ml` → `ActionError` (v1 seam).

- [ ] **Step 1: Write the failing test**

`test/actions.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  createGame,
  getMoves,
  isMlGame,
  joinGame,
  submitMove,
} from "../src/actions";
import { getGameByGuid, writeGame } from "../src/db";
import { ActionError } from "../src/errors";
import { InvalidSecret } from "../src/exceptions";

describe("create_game", () => {
  it("creates a game with a player 1 secret and board html", async () => {
    const resp = await createGame(env.DB, {});
    expect(resp.game_guid).toBeTruthy();
    expect(resp.secret).toBeTruthy();
    expect(resp.play_against_ml).toBe(false);
    expect(resp.html).toContain("<table>");
    const game = await getGameByGuid(env.DB, resp.game_guid);
    expect(game.player1Secret).toBe(resp.secret);
    expect(game.player2Secret).toBe("");
  });

  it("rejects play_against_ml in v1 (bot seam)", async () => {
    await expect(createGame(env.DB, { play_against_ml: true })).rejects.toThrow(
      "Play against ML is not yet supported"
    );
    await expect(
      createGame(env.DB, { play_against_ml: "true" })
    ).rejects.toBeInstanceOf(ActionError);
  });
});

describe("join_game", () => {
  it("assigns a player 2 secret exactly once", async () => {
    const created = await createGame(env.DB, {});
    const joined = await joinGame(env.DB, { game_guid: created.game_guid });
    expect(joined.secret).toBeTruthy();
    expect(joined.secret).not.toBe(created.secret);
    await expect(
      joinGame(env.DB, { game_guid: created.game_guid })
    ).rejects.toThrow("Game is already joined");
  });

  it("requires game_guid", async () => {
    await expect(joinGame(env.DB, {})).rejects.toThrow(
      "Missing required field: game_guid"
    );
  });

  it("refuses ML games (bot seam)", async () => {
    const mlGame = {
      gameGuid: "ml-1",
      player1Secret: "s1",
      player2Secret: "__ML_BOT__:abc",
    };
    await writeGame(env.DB, mlGame);
    expect(isMlGame(mlGame)).toBe(true);
    await expect(joinGame(env.DB, { game_guid: "ml-1" })).rejects.toThrow(
      "Game is configured for Play against ML and cannot be joined"
    );
  });
});

describe("submit_move", () => {
  it("validates the secret", async () => {
    const created = await createGame(env.DB, {});
    await expect(
      submitMove(env.DB, {
        game_guid: created.game_guid,
        move: "a1b",
        secret: "wrong",
        player: 1,
      })
    ).rejects.toBeInstanceOf(InvalidSecret);
  });

  it("records the move and returns round state", async () => {
    const created = await createGame(env.DB, {});
    const resp = await submitMove(env.DB, {
      game_guid: created.game_guid,
      move: "a1b",
      secret: created.secret,
      player: 1,
    });
    expect(resp.player_1_move_count).toBe(1);
    expect(resp.player_2_move_count).toBe(0);
    expect(resp.round_complete).toBe(false);
    expect(resp.html).toContain("<table>");
  });

  it("rejects malformed and invalid moves", async () => {
    const created = await createGame(env.DB, {});
    const base = {
      game_guid: created.game_guid,
      secret: created.secret,
      player: 1,
    };
    await expect(submitMove(env.DB, { ...base, move: "zzz" })).rejects.toThrow(
      "Improperly formatted move"
    );
    await expect(submitMove(env.DB, { ...base, move: "a1i" })).rejects.toThrow(
      "Invalid move: 'a1i'."
    );
  });

  it("blocks player 2 on ML games (bot seam)", async () => {
    await writeGame(env.DB, {
      gameGuid: "ml-2",
      player1Secret: "s1",
      player2Secret: "__ML_BOT__:abc",
    });
    await expect(
      submitMove(env.DB, {
        game_guid: "ml-2",
        move: "i1h",
        secret: "__ML_BOT__:abc",
        player: 2,
      })
    ).rejects.toThrow("Player 2 is controlled by ML for this game");
  });
});

describe("get_moves", () => {
  it("returns current round state after a full round", async () => {
    const created = await createGame(env.DB, {});
    const joined = await joinGame(env.DB, { game_guid: created.game_guid });
    for (const m of ["a1b", "a1d", "b1e"]) {
      await submitMove(env.DB, {
        game_guid: created.game_guid,
        move: m,
        secret: created.secret,
        player: 1,
      });
    }
    for (const m of ["i1h", "i1f", "h1e"]) {
      await submitMove(env.DB, {
        game_guid: created.game_guid,
        move: m,
        secret: joined.secret,
        player: 2,
      });
    }
    const resp = await getMoves(env.DB, {
      game_guid: created.game_guid,
      secret: created.secret,
      player: 1,
    });
    expect(resp.completed_rounds).toBe(1);
    expect(resp.round_complete).toBe(true);
    expect(resp.player_1_move_count).toBe(3);
    expect(resp.player_2_move_count).toBe(3);
  });

  it("validates the secret", async () => {
    const created = await createGame(env.DB, {});
    await expect(
      getMoves(env.DB, {
        game_guid: created.game_guid,
        secret: "wrong",
        player: 1,
      })
    ).rejects.toBeInstanceOf(InvalidSecret);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/actions.test.ts`
Expected: FAIL — cannot resolve `../src/actions`.

- [ ] **Step 3: Write the implementation**

`src/actions.ts`:

```ts
import { Board, Move } from "./engine";
import { InvalidSecret } from "./exceptions";
import { ActionError } from "./errors";
import {
  type Game,
  type RoundState,
  getBoardAndRoundState,
  getGameByGuid,
  saveMove,
  updateGame,
  writeGame,
} from "./db";

export const ML_BOT_SECRET_PREFIX = "__ML_BOT__";

export interface ResponseContent {
  game_guid: string;
  secret: string;
  html: string;
  play_against_ml?: boolean;
  player_1_move_count?: number;
  player_2_move_count?: number;
  completed_rounds?: number;
  round_complete?: boolean;
}

export function isMlGame(game: Game): boolean {
  return game.player2Secret.startsWith(ML_BOT_SECRET_PREFIX);
}

function parseBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Boolean(value);
  if (typeof value === "string") {
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  }
  return false;
}

function requireFields(
  body: Record<string, unknown>,
  fields: string[]
): unknown[] {
  return fields.map((field) => {
    if (!(field in body)) {
      throw new ActionError(`Missing required field: ${field}`);
    }
    return body[field];
  });
}

function secretForPlayer(game: Game, player: unknown): string {
  const key = String(player);
  if (key === "1") return game.player1Secret;
  if (key === "2") return game.player2Secret;
  throw new ActionError(`Invalid player: ${key}`);
}

function roundStateResponse(
  gameGuid: string,
  secret: string,
  playAgainstMl: boolean,
  rs: RoundState
): ResponseContent {
  return {
    game_guid: gameGuid,
    secret,
    html: rs.board.toHtmlTable(),
    play_against_ml: playAgainstMl,
    player_1_move_count: rs.p1Count,
    player_2_move_count: rs.p2Count,
    completed_rounds: rs.completedRounds,
    round_complete: rs.roundComplete,
  };
}

export async function createGame(
  d1: D1Database,
  body: Record<string, unknown>
): Promise<ResponseContent> {
  if (parseBool(body.play_against_ml)) {
    // v1 ships without the bot; re-add per the design spec's seam section.
    throw new ActionError("Play against ML is not yet supported");
  }
  const game: Game = {
    gameGuid: crypto.randomUUID(),
    player1Secret: crypto.randomUUID(),
    player2Secret: "",
  };
  await writeGame(d1, game);
  return {
    game_guid: game.gameGuid,
    secret: game.player1Secret,
    html: new Board().toHtmlTable(),
    play_against_ml: false,
  };
}

export async function joinGame(
  d1: D1Database,
  body: Record<string, unknown>
): Promise<ResponseContent> {
  const [gameGuid] = requireFields(body, ["game_guid"]) as [string];
  const game = await getGameByGuid(d1, gameGuid);

  if (isMlGame(game)) {
    throw new ActionError(
      "Game is configured for Play against ML and cannot be joined"
    );
  }
  if (game.player2Secret) {
    throw new ActionError("Game is already joined");
  }

  game.player2Secret = crypto.randomUUID();
  await updateGame(d1, game);

  return {
    game_guid: game.gameGuid,
    secret: game.player2Secret,
    html: new Board().toHtmlTable(),
    play_against_ml: false,
  };
}

export async function submitMove(
  d1: D1Database,
  body: Record<string, unknown>
): Promise<ResponseContent> {
  const [gameGuid, moveStr, secret, player] = requireFields(body, [
    "game_guid",
    "move",
    "secret",
    "player",
  ]) as [string, string, string, unknown];

  const game = await getGameByGuid(d1, gameGuid);
  const playAgainstMl = isMlGame(game);

  if (playAgainstMl && String(player) === "2") {
    throw new ActionError("Player 2 is controlled by ML for this game");
  }
  if (secretForPlayer(game, player) !== secret) {
    throw new InvalidSecret();
  }

  const move = new Move(moveStr);
  const rs = await saveMove(d1, gameGuid, move, Number(player));
  // Bot auto-submission hook: when the bot returns, ML trio generation
  // slots in here (design spec, "ML bot seam").
  return roundStateResponse(gameGuid, secret, playAgainstMl, rs);
}

export async function getMoves(
  d1: D1Database,
  body: Record<string, unknown>
): Promise<ResponseContent> {
  const [gameGuid, secret, player] = requireFields(body, [
    "game_guid",
    "secret",
    "player",
  ]) as [string, string, unknown];

  const game = await getGameByGuid(d1, gameGuid);
  if (secretForPlayer(game, player) !== secret) {
    throw new InvalidSecret();
  }

  const rs = await getBoardAndRoundState(d1, gameGuid);
  return roundStateResponse(gameGuid, secret, isMlGame(game), rs);
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/actions.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/actions.ts test/actions.test.ts
git commit -m "feat: port the four game actions with ML bot seam"
```

---

### Task 7: Router + HTTP integration tests

**Files:**
- Modify: `src/index.ts` (replace stub)
- Test: `test/integration.test.ts`

**Interfaces:**
- Consumes: action functions + `ResponseContent` from Task 6, `ActionError`, `BaseAllsfairError`.
- Produces: worker `fetch` handler — `POST /api` with JSON `{action, ...}` → 200 JSON `ResponseContent`; `ActionError`/`BaseAllsfairError` → 400 plain text (message only); unknown action → 400 `Invalid action: <name>`; non-POST on `/api` → 400 `Invalid request`; other paths → 404 (static assets are served by the platform before the worker runs, so the worker only ever sees non-asset requests).

- [ ] **Step 1: Write the failing test**

`test/integration.test.ts`:

```ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function api(body: unknown): Promise<Response> {
  return SELF.fetch("https://example.com/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api", () => {
  it("plays a full PvP round over HTTP", async () => {
    const created = (await (await api({ action: "create_game" })).json()) as any;
    expect(created.game_guid).toBeTruthy();

    const joined = (await (
      await api({ action: "join_game", game_guid: created.game_guid })
    ).json()) as any;

    for (const move of ["a1b", "a1d", "b1e"]) {
      const resp = await api({
        action: "submit_move",
        game_guid: created.game_guid,
        move,
        secret: created.secret,
        player: 1,
      });
      expect(resp.status).toBe(200);
    }
    let last: any;
    for (const move of ["i1h", "i1f", "h1e"]) {
      const resp = await api({
        action: "submit_move",
        game_guid: created.game_guid,
        move,
        secret: joined.secret,
        player: 2,
      });
      expect(resp.status).toBe(200);
      last = await resp.json();
    }
    expect(last.round_complete).toBe(true);
    expect(last.completed_rounds).toBe(1);
    expect(last.html).toContain("<table>");
  });

  it("returns 400 with the exception message for a wrong secret", async () => {
    const created = (await (await api({ action: "create_game" })).json()) as any;
    const resp = await api({
      action: "submit_move",
      game_guid: created.game_guid,
      move: "a1b",
      secret: "wrong",
      player: 1,
    });
    expect(resp.status).toBe(400);
    expect(await resp.text()).toBe("Invalid secret");
  });

  it("returns 400 for an unknown action", async () => {
    const resp = await api({ action: "explode" });
    expect(resp.status).toBe(400);
    expect(await resp.text()).toBe("Invalid action: explode");
  });

  it("returns 400 for play_against_ml (v1 bot seam)", async () => {
    const resp = await api({ action: "create_game", play_against_ml: true });
    expect(resp.status).toBe(400);
    expect(await resp.text()).toBe("Play against ML is not yet supported");
  });

  it("returns 400 for non-POST and invalid JSON", async () => {
    const get = await SELF.fetch("https://example.com/api");
    expect(get.status).toBe(400);
    const bad = await SELF.fetch("https://example.com/api", {
      method: "POST",
      body: "not json",
    });
    expect(bad.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration.test.ts`
Expected: FAIL — stub returns 404 for everything.

- [ ] **Step 3: Replace `src/index.ts`**

```ts
import {
  createGame,
  getMoves,
  joinGame,
  submitMove,
  type ResponseContent,
} from "./actions";
import { ActionError } from "./errors";
import { BaseAllsfairError } from "./exceptions";

export interface Env {
  DB: D1Database;
}

type ActionHandler = (
  db: D1Database,
  body: Record<string, unknown>
) => Promise<ResponseContent>;

const actionHandlers: Record<string, ActionHandler> = {
  create_game: createGame,
  join_game: joinGame,
  submit_move: submitMove,
  get_moves: getMoves,
};

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/api") {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "POST") {
      return new Response("Invalid request", { status: 400 });
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json<Record<string, unknown>>();
    } catch {
      return new Response("Invalid JSON body", { status: 400 });
    }

    const handler = actionHandlers[String(body.action)];
    if (!handler) {
      return new Response(`Invalid action: ${body.action}`, { status: 400 });
    }

    try {
      const content = await handler(env.DB, body);
      return Response.json(content);
    } catch (error) {
      if (error instanceof BaseAllsfairError || error instanceof ActionError) {
        return new Response(error.message, { status: 400 });
      }
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;
```

Also delete `test/smoke.test.ts` (superseded by real suites).

- [ ] **Step 4: Run the full suite + typecheck**

Run: `npm test && npx tsc`
Expected: all suites PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add /api router with error-to-400 mapping"
```

---

### Task 8: Frontend

**Files:**
- Create: `public/index.html` (copied from `allsfair-python-function/frontend/index.html`, two edits)
- Delete: `public/.gitkeep`

- [ ] **Step 1: Copy and edit**

```bash
cp /Users/floyd/code/allsfair/allsfair-python-function/frontend/index.html \
   /Users/floyd/code/allsfair/allsfair-worker/public/index.html
rm /Users/floyd/code/allsfair/allsfair-worker/public/.gitkeep
```

Edit 1 — API URL (line ~373), same-origin now:

```js
// before
const API_URL = 'http://localhost:8081/';
// after
const API_URL = '/api';
```

Edit 2 — hide the bot toggle until the bot ships (line ~286; keep the markup so re-enabling is a one-line change):

```html
<!-- before -->
<div class="mode-toggle">
<!-- after: bot returns in v2 (see design spec, "ML bot seam") -->
<div class="mode-toggle" style="display:none">
```

- [ ] **Step 2: Verify locally**

```bash
cd /Users/floyd/code/allsfair/allsfair-worker
npx wrangler dev
```

In a browser at the printed localhost URL: create a game (player 1), copy the game id, open a second private window, join, submit `a1b`/`a1d`/`b1e` as P1 and `i1h`/`i1f`/`h1e` as P2, confirm the board updates and the round completes. Ctrl-C when done.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: serve frontend from worker assets, point API at /api"
```

---

### Task 9: Deploy to Cloudflare + subdomain

Auth and the domain name need the user — pause and ask for the desired subdomain (e.g. `allsfair.example.com`) before this task, and have them run `npx wrangler login` via `! npx wrangler login` if not already authenticated.

- [ ] **Step 1: Create the production D1 database**

```bash
cd /Users/floyd/code/allsfair/allsfair-worker
npx wrangler d1 create allsfair
```

Expected output includes a `database_id` UUID. Replace the dummy `database_id` in `wrangler.toml` with it.

- [ ] **Step 2: Apply migrations remotely**

```bash
npx wrangler d1 migrations apply allsfair --remote
```

Expected: `0001_init.sql` listed as applied.

- [ ] **Step 3: Add the custom domain route**

Append to `wrangler.toml` (substitute the user's actual subdomain):

```toml
routes = [
  { pattern = "allsfair.USERDOMAIN.tld", custom_domain = true }
]
```

- [ ] **Step 4: Deploy**

```bash
npx wrangler deploy
```

Expected: deploy succeeds and prints the route. Cloudflare provisions DNS + TLS for the custom domain automatically (zone is already on Cloudflare).

- [ ] **Step 5: Smoke test production**

```bash
curl -s -X POST https://allsfair.USERDOMAIN.tld/api \
  -H 'Content-Type: application/json' \
  -d '{"action": "create_game"}'
```

Expected: 200 JSON with `game_guid`, `secret`, `html`. Then load the subdomain in a browser and play a full PvP round (two windows).

- [ ] **Step 6: Commit and report**

```bash
git add wrangler.toml
git commit -m "chore: wire production D1 database and custom domain route"
```

Report to the user: the game's URL, and the GCP decommission checklist from the spec (delete Cloud Function `allsfair-python`, BigQuery dataset, GCS checkpoint bucket, Cloud Build trigger) — these are destructive and the user runs them after verifying the cutover.

---

## Self-Review Notes

- Spec coverage: architecture (T1, T7), D1 schema + id fix (T1), engine port (T2–T3), actions + API behavior (T6–T7), ML seam (T6 create/join/submit guards + hidden toggle in T8), parity testing (T4), action tests (T5–T6), manual smoke (T8, T9), deployment + custom domain (T9), decommission (T9 report, user-run). Frontend `API_URL` change (T8). Out-of-scope items untouched.
- Deviations captured in Global Constraints (unknown-square `InvalidMove`, single game query per action, 400s instead of uncaught 500s).
- Type consistency: `Game`/`RoundState` defined once in `db.ts`; `ResponseContent` once in `actions.ts`; handlers all `(D1Database, Record<string, unknown>) => Promise<ResponseContent>`.
