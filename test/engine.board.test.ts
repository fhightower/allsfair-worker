import { describe, expect, it } from "vitest";
import { Board, Move, MovePair } from "../src/engine";

function pair(p1: string, p2: string): MovePair {
  return new MovePair(new Move(p1), new Move(p2));
}

describe("Board basics", () => {
  it("starts with 3 troops on each home square", () => {
    const board = new Board();
    expect(board.state.a).toMatchObject({ owner: 1, troopCount: 3 });
    expect(board.state.i).toMatchObject({ owner: 2, troopCount: 3 });
    expect(board.winner).toBe(0);
  });

  it("moves troops and captures empty squares", () => {
    const board = new Board();
    board.applyMovePair(pair("a2b", "i2h"));
    expect(board.state.a.troopCount).toBe(1);
    expect(board.state.b).toMatchObject({ owner: 1, troopCount: 2 });
    expect(board.state.h).toMatchObject({ owner: 2, troopCount: 2 });
  });

  it("clamps a move to available troops", () => {
    const board = new Board();
    board.applyMovePair(pair("a9b", "i1h"));
    expect(board.state.a.troopCount).toBe(0);
    expect(board.state.b.troopCount).toBe(3);
  });

  it("zeroes a move from a square the team does not own", () => {
    const board = new Board();
    board.applyMovePair(pair("b1e", "i1h"));
    expect(board.state.b.troopCount).toBe(0);
    expect(board.state.e).toMatchObject({ owner: 0, troopCount: 0 });
    expect(board.state.h).toMatchObject({ owner: 2, troopCount: 1 });
  });
});

describe("combat", () => {
  it("equal collision destroys both forces", () => {
    const board = new Board();
    board.applyMovePair(pair("a3b", "i3h"));
    board.applyMovePair(pair("b3e", "h3e"));
    expect(board.state.b.troopCount).toBe(0);
    expect(board.state.h.troopCount).toBe(0);
    expect(board.state.e).toMatchObject({ owner: 0, troopCount: 0 });
  });

  it("unequal collision leaves the larger force's residual", () => {
    const board = new Board();
    board.applyMovePair(pair("a3b", "i2h"));
    board.applyMovePair(pair("b3e", "h2e"));
    expect(board.state.e).toMatchObject({ owner: 1, troopCount: 1 });
  });

  it("unequal swap conquers the smaller force's square", () => {
    const board = new Board();
    board.applyMovePair(pair("a3b", "i3f"));
    board.applyMovePair(pair("b3e", "f1i"));
    board.applyMovePair(pair("e3f", "f2e")); // swap: 3 vs 2 -> P1 residual 1 into f
    expect(board.state.f).toMatchObject({ owner: 1, troopCount: 1 });
    expect(board.state.e).toMatchObject({ owner: 1, troopCount: 0 });
  });

  it("attacking a defended square subtracts troops and flips owner on overrun", () => {
    const board = new Board();
    board.applyMovePair(pair("a3b", "i1h"));
    board.applyMovePair(pair("b3e", "i1h"));
    board.applyMovePair(pair("e3h", "i1f")); // 3 attack h defended by 2 -> owner flips, 1 remains
    expect(board.state.h).toMatchObject({ owner: 1, troopCount: 1 });
  });
});

describe("winner and restock", () => {
  it("declares team 2 winner when team 1 base is taken and team 1 has no populated squares", () => {
    const board = new Board();
    board.state.a.owner = 2;
    board.state.a.troopCount = 1;
    expect(board.winner).toBe(2);
  });

  it("declares team 1 winner when team 2 base is taken and team 2 has no populated squares", () => {
    const board = new Board();
    board.state.i.owner = 1;
    expect(board.winner).toBe(1);
  });

  it("restocks home squares by number of owned squares", () => {
    const board = new Board();
    board.applyMovePair(pair("a1b", "i1h"));
    board.restock();
    expect(board.state.a.troopCount).toBe(4); // 2 left + 2 squares owned
    expect(board.state.i.troopCount).toBe(4);
  });

  it("does not restock once a winner exists", () => {
    const board = new Board();
    board.state.i.owner = 1;
    board.restock();
    expect(board.state.a.troopCount).toBe(3);
  });
});

describe("history and html", () => {
  it("records post-move snapshots newest-first", () => {
    const board = new Board();
    board.applyMovePair(pair("a1b", "i1h"));
    board.applyMovePair(pair("a1d", "i1f"));
    expect(board.history).toHaveLength(2);
    expect(board.history[0].team1MoveStr).toBe("a1d");
    expect(board.history[1].state.b.troopCount).toBe(1);
  });

  it("snapshots are not mutated by later moves", () => {
    const board = new Board();
    board.applyMovePair(pair("a1b", "i1h"));
    const snapshot = board.history[0].state;
    board.applyMovePair(pair("a1b", "i1h"));
    expect(snapshot.b.troopCount).toBe(1);
  });

  it("history records the mutated move (clamped count)", () => {
    const board = new Board();
    board.applyMovePair(pair("a9b", "i1h"));
    expect(board.history[0].team1MoveStr).toBe("a3b");
  });

  it("renders board, history, and style block", () => {
    const board = new Board();
    board.applyMovePair(pair("a2b", "i2h"));
    const html = board.toHtmlTable();
    expect(html).toContain("<td class='player1'>a: 1</td>");
    expect(html).toContain("Starting board");
    expect(html).toContain("Moves: P1 a2b, P2 i2h");
    expect(html).toContain("<summary>History</summary>");
    expect(html).toContain("<style>");
  });

  it("shows the winner banner", () => {
    const board = new Board();
    board.state.i.owner = 1;
    expect(board.toHtmlTable()).toContain(
      "Winner is team <span class='player1'>1</span>"
    );
  });
});
