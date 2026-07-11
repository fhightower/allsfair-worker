// Trio-level candidate-search bot. Port of the measured Python prototype
// (allsfair repo, scripts/search_bot_eval.py): 76% wins vs heuristic,
// 94% vs the old hybrid Q-bot. Weights and parameters are measured values —
// re-run the Python eval harness before changing them.
//
// Known deviation from the prototype: score ties break on the real move
// string here vs the mirrored action key in Python, and the RNG streams
// differ — so move-for-move trajectories diverge. Strength is verified
// directly by test/bot.strength.test.ts, not by cross-language parity.
import { Board, Move, MovePair, TEAM_1, TEAM_2 } from "./engine";
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
    const score = MIN_WEIGHT * Math.min(...outcomes) + (1 - MIN_WEIGHT) * mean;
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
