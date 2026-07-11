import { beforeEach, describe, expect, it } from "vitest";
import {
  claimPlayer2Slot,
  GameNotFound,
  getMlRoundContext,
  getBoardAndRoundState,
  getGameByGuid,
  getMovesForGuid,
  saveMove,
  writeBotMoveIfCountMatches,
  writeGame,
  writeMove,
} from "../src/db";
import { Move } from "../src/engine";
import { createTestDb } from "./d1-shim";

const game = { gameGuid: "g-1", player1Secret: "s1", player2Secret: "" };

let db: D1Database;
beforeEach(() => {
  db = createTestDb();
});

describe("games", () => {
  it("writes and reads a game", async () => {
    await writeGame(db, game);
    expect(await getGameByGuid(db, "g-1")).toEqual(game);
  });

  it("throws GameNotFound for an unknown guid", async () => {
    await expect(getGameByGuid(db, "nope")).rejects.toBeInstanceOf(GameNotFound);
    await expect(getGameByGuid(db, "nope")).rejects.toThrow(
      "No game found with guid: nope"
    );
  });

  it("claims the player 2 slot exactly once", async () => {
    await writeGame(db, game);
    expect(await claimPlayer2Slot(db, "g-1", "s2")).toBe(true);
    expect((await getGameByGuid(db, "g-1")).player2Secret).toBe("s2");
    // second concurrent-style claim loses
    expect(await claimPlayer2Slot(db, "g-1", "s3")).toBe(false);
    expect((await getGameByGuid(db, "g-1")).player2Secret).toBe("s2");
  });
});

describe("moves and round state", () => {
  it("returns moves in insertion order", async () => {
    await writeMove(db, "g-1", new Move("a1b"), 1);
    await writeMove(db, "g-1", new Move("i1h"), 2);
    expect(await getMovesForGuid(db, "g-1")).toEqual([
      { moveString: "a1b", player: 1 },
      { moveString: "i1h", player: 2 },
    ]);
  });

  it("replays the board and reports round state", async () => {
    for (const m of ["a1b", "a1d", "b1e"]) {
      await writeMove(db, "g-2", new Move(m), 1);
    }
    for (const m of ["i1h", "i1f", "h1e"]) {
      await writeMove(db, "g-2", new Move(m), 2);
    }
    const rs = await getBoardAndRoundState(db, "g-2");
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
    const rs = await saveMove(db, "g-3", new Move("a1b"), 1);
    expect(rs.p1Count).toBe(1);
    expect(rs.p2Count).toBe(0);
    expect(rs.roundComplete).toBe(false);
  });
});

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
    // round 0 replayed incl. restock; pair 3 (b1e vs h1e) equal-collides
    expect(ctx.board.state.a.troopCount).toBe(4);
    expect(ctx.board.state.i.troopCount).toBe(4);
    expect(ctx.botMovesInRound).toEqual([]);
  });
});

describe("writeBotMoveIfCountMatches", () => {
  it("inserts only when the player-2 move count matches", async () => {
    expect(await writeBotMoveIfCountMatches(db, "g-b", "i1h", 0)).toBe(true);
    // stale expectation (another writer won): no insert
    expect(await writeBotMoveIfCountMatches(db, "g-b", "i1f", 0)).toBe(false);
    expect(await writeBotMoveIfCountMatches(db, "g-b", "i1f", 1)).toBe(true);
    expect(await getMovesForGuid(db, "g-b")).toEqual([
      { moveString: "i1h", player: 2 },
      { moveString: "i1f", player: 2 },
    ]);
  });

  it("counts only player-2 moves in the guard", async () => {
    await writeMove(db, "g-c", new Move("a1b"), 1);
    expect(await writeBotMoveIfCountMatches(db, "g-c", "i1h", 0)).toBe(true);
  });
});
