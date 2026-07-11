// Port of actions.py. The ML bot is not shipped in v1, but its seam is kept:
// the __ML_BOT__ secret convention, the ML guards in join/submit, and the
// auto-submission hook point in submitMove (see the design spec).
import { planBotTrio } from "./bot";
import { Board, Move } from "./engine";
import { InvalidSecret } from "./exceptions";
import { ActionError } from "./errors";
import {
  type Game,
  type RoundState,
  getBoardAndRoundState,
  getGameByGuid,
  claimPlayer2Slot,
  getMlRoundContext,
  saveMove,
  writeBotMoveIfCountMatches,
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

// Port of the Python `_generate_ml_moves_if_needed`: once player 1 has
// finished a trio and the bot is behind, plan the bot's trio from the
// round-start board and write the missing moves. Each write is count-guarded
// so concurrent requests (submit_move racing a get_moves poll) can't both
// insert a trio — the loser writes nothing and returns fresh state.
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

    let expectedP2Count = roundIndex * 3 + botMovesInRound.length;
    let lostRace = false;
    for (const moveStr of pending) {
      const won = await writeBotMoveIfCountMatches(
        d1,
        gameGuid,
        moveStr,
        expectedP2Count
      );
      if (!won) {
        lostRace = true;
        break;
      }
      expectedP2Count++;
    }

    rs = await getBoardAndRoundState(d1, gameGuid);
    if (lostRace) break; // a concurrent request is writing this trio
  }
  return rs;
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
  const secret = crypto.randomUUID();
  const claimed = await claimPlayer2Slot(d1, gameGuid, secret);
  if (!claimed) {
    throw new ActionError("Game is already joined");
  }

  return {
    game_guid: game.gameGuid,
    secret,
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
  let rs = await saveMove(d1, gameGuid, move, Number(player));
  if (playAgainstMl && String(player) === "1") {
    rs = await generateMlMovesIfNeeded(d1, gameGuid, rs);
  }
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

  const playAgainstMl = isMlGame(game);
  let rs = await getBoardAndRoundState(d1, gameGuid);
  if (playAgainstMl && String(player) === "1") {
    rs = await generateMlMovesIfNeeded(d1, gameGuid, rs);
  }
  return roundStateResponse(gameGuid, secret, playAgainstMl, rs);
}
