// Port of bq.py + db.py onto D1. Board state is derived by replaying the
// move log, exactly like the Python implementation.
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

/**
 * Atomically claim the player-2 slot. Conditional UPDATE prevents the
 * lost-update race where two concurrent joins both pass a read-side check
 * and the second silently overwrites the first joiner's secret.
 */
export async function claimPlayer2Slot(
  db: D1Database,
  gameGuid: string,
  secret: string
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE games SET player_2_secret = ? WHERE game_guid = ? AND player_2_secret = ''"
    )
    .bind(secret, gameGuid)
    .run();
  return result.meta.changes > 0;
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

/**
 * Count-guarded bot-move insert: writes the move only if the game's current
 * player-2 move count equals `expectedP2Count`. Makes concurrent bot-trio
 * generation single-winner — the loser inserts nothing.
 */
export async function writeBotMoveIfCountMatches(
  db: D1Database,
  gameGuid: string,
  moveString: string,
  expectedP2Count: number
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO moves (game_guid, move_string, player)
       SELECT ?, ?, 2
       WHERE (SELECT COUNT(*) FROM moves WHERE game_guid = ? AND player = 2) = ?`
    )
    .bind(gameGuid, moveString, gameGuid, expectedP2Count)
    .run();
  return result.meta.changes > 0;
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
