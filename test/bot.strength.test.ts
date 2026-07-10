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
