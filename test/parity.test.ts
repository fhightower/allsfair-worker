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
  for (const scenario of fixtures as unknown as Scenario[]) {
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
