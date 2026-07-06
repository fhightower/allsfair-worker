// Port of actions.py. The ML bot is not shipped in v1, but its seam is kept:
// the __ML_BOT__ secret convention, the ML guards in join/submit, and the
// auto-submission hook point in submitMove (see the design spec).
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
  // slots in here.
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
