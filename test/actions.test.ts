import { beforeEach, describe, expect, it } from "vitest";
import {
  createGame,
  getMoves,
  isMlGame,
  joinGame,
  submitMove,
} from "../src/actions";
import { getGameByGuid, writeGame, writeMove } from "../src/db";
import { Move } from "../src/engine";
import { InvalidSecret } from "../src/exceptions";
import { createTestDb } from "./d1-shim";

let db: D1Database;
beforeEach(() => {
  db = createTestDb();
});

describe("create_game", () => {
  it("creates a game with a player 1 secret and board html", async () => {
    const resp = await createGame(db, {});
    expect(resp.game_guid).toBeTruthy();
    expect(resp.secret).toBeTruthy();
    expect(resp.play_against_ml).toBe(false);
    expect(resp.html).toContain("<table>");
    const game = await getGameByGuid(db, resp.game_guid);
    expect(game.player1Secret).toBe(resp.secret);
    expect(game.player2Secret).toBe("");
  });

  it("creates a bot game when play_against_ml is set", async () => {
    const resp = await createGame(db, { play_against_ml: true });
    expect(resp.play_against_ml).toBe(true);
    const game = await getGameByGuid(db, resp.game_guid);
    expect(game.player2Secret.startsWith("__ML_BOT__")).toBe(true);
    expect(isMlGame(game)).toBe(true);
  });
});

describe("join_game", () => {
  it("assigns a player 2 secret exactly once", async () => {
    const created = await createGame(db, {});
    const joined = await joinGame(db, { game_guid: created.game_guid });
    expect(joined.secret).toBeTruthy();
    expect(joined.secret).not.toBe(created.secret);
    await expect(
      joinGame(db, { game_guid: created.game_guid })
    ).rejects.toThrow("Game is already joined");
  });

  it("requires game_guid", async () => {
    await expect(joinGame(db, {})).rejects.toThrow(
      "Missing required field: game_guid"
    );
  });

  it("refuses ML games (bot seam)", async () => {
    const mlGame = {
      gameGuid: "ml-1",
      player1Secret: "s1",
      player2Secret: "__ML_BOT__:abc",
    };
    await writeGame(db, mlGame);
    expect(isMlGame(mlGame)).toBe(true);
    await expect(joinGame(db, { game_guid: "ml-1" })).rejects.toThrow(
      "Game is configured for Play against ML and cannot be joined"
    );
  });
});

describe("submit_move", () => {
  it("validates the secret", async () => {
    const created = await createGame(db, {});
    await expect(
      submitMove(db, {
        game_guid: created.game_guid,
        move: "a1b",
        secret: "wrong",
        player: 1,
      })
    ).rejects.toBeInstanceOf(InvalidSecret);
  });

  it("records the move and returns round state", async () => {
    const created = await createGame(db, {});
    const resp = await submitMove(db, {
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
    const created = await createGame(db, {});
    const base = {
      game_guid: created.game_guid,
      secret: created.secret,
      player: 1,
    };
    await expect(submitMove(db, { ...base, move: "zzz" })).rejects.toThrow(
      "Improperly formatted move"
    );
    await expect(submitMove(db, { ...base, move: "a1i" })).rejects.toThrow(
      "Invalid move: 'a1i'."
    );
  });

  it("blocks player 2 on ML games (bot seam)", async () => {
    await writeGame(db, {
      gameGuid: "ml-2",
      player1Secret: "s1",
      player2Secret: "__ML_BOT__:abc",
    });
    await expect(
      submitMove(db, {
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
    const created = await createGame(db, {});
    const joined = await joinGame(db, { game_guid: created.game_guid });
    for (const m of ["a1b", "a1d", "b1e"]) {
      await submitMove(db, {
        game_guid: created.game_guid,
        move: m,
        secret: created.secret,
        player: 1,
      });
    }
    for (const m of ["i1h", "i1f", "h1e"]) {
      await submitMove(db, {
        game_guid: created.game_guid,
        move: m,
        secret: joined.secret,
        player: 2,
      });
    }
    const resp = await getMoves(db, {
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
    const created = await createGame(db, {});
    await expect(
      getMoves(db, {
        game_guid: created.game_guid,
        secret: "wrong",
        player: 1,
      })
    ).rejects.toBeInstanceOf(InvalidSecret);
  });
});

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

  it("concurrent polls generate the bot trio exactly once", async () => {
    const created = await createBotGame();
    // write P1's trio directly so bot generation is still pending
    for (const m of ["a1b", "a1d", "b1e"]) {
      await writeMove(db, created.game_guid, new Move(m), 1);
    }
    const q = { game_guid: created.game_guid, secret: created.secret, player: 1 };
    await Promise.all([getMoves(db, q), getMoves(db, q)]);
    const final = await getMoves(db, q);
    expect(final.player_2_move_count).toBe(3);
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
