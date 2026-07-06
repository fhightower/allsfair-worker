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
