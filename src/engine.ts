// Port of allsfair/models.py. The Python engine is the source of truth for
// game rules; test/parity.test.ts replays Python-generated fixtures to keep
// this port byte-identical (including toHtmlTable output).
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

// Key order matters: Object.entries() iterates a..i, which drives the
// 3-per-row HTML layout exactly like the Python dict.
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
