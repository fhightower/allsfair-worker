import { beforeEach, describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index";
import { createTestDb } from "./d1-shim";

let env: Env;
beforeEach(() => {
  env = { DB: createTestDb() };
});

function fetchWorker(request: Request): Promise<Response> {
  // The handler only uses (request, env); cast covers the workers-types
  // Request/ExecutionContext extras that plain node doesn't have.
  return (worker.fetch as unknown as (r: Request, e: Env) => Promise<Response>)(
    request,
    env
  );
}

function api(body: unknown): Promise<Response> {
  return fetchWorker(
    new Request("https://example.com/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

describe("POST /api", () => {
  it("plays a full PvP round over HTTP", async () => {
    const createResp = await api({ action: "create_game" });
    expect(createResp.status).toBe(200);
    const created = (await createResp.json()) as any;
    expect(created.game_guid).toBeTruthy();

    const joined = (await (
      await api({ action: "join_game", game_guid: created.game_guid })
    ).json()) as any;

    for (const move of ["a1b", "a1d", "b1e"]) {
      const resp = await api({
        action: "submit_move",
        game_guid: created.game_guid,
        move,
        secret: created.secret,
        player: 1,
      });
      expect(resp.status).toBe(200);
    }
    let last: any;
    for (const move of ["i1h", "i1f", "h1e"]) {
      const resp = await api({
        action: "submit_move",
        game_guid: created.game_guid,
        move,
        secret: joined.secret,
        player: 2,
      });
      expect(resp.status).toBe(200);
      last = await resp.json();
    }
    expect(last.round_complete).toBe(true);
    expect(last.completed_rounds).toBe(1);
    expect(last.html).toContain("<table>");
  });

  it("returns 400 with the exception message for a wrong secret", async () => {
    const created = (await (await api({ action: "create_game" })).json()) as any;
    const resp = await api({
      action: "submit_move",
      game_guid: created.game_guid,
      move: "a1b",
      secret: "wrong",
      player: 1,
    });
    expect(resp.status).toBe(400);
    expect(await resp.text()).toBe("Invalid secret");
  });

  it("returns 400 for an unknown action", async () => {
    const resp = await api({ action: "explode" });
    expect(resp.status).toBe(400);
    expect(await resp.text()).toBe("Invalid action: explode");
  });

  it("returns 400 for an unknown game", async () => {
    const resp = await api({ action: "join_game", game_guid: "nope" });
    expect(resp.status).toBe(400);
    expect(await resp.text()).toBe("No game found with guid: nope");
  });

  it("returns 400 for play_against_ml (v1 bot seam)", async () => {
    const resp = await api({ action: "create_game", play_against_ml: true });
    expect(resp.status).toBe(400);
    expect(await resp.text()).toBe("Play against ML is not yet supported");
  });

  it("returns 400 for non-POST and invalid JSON", async () => {
    const get = await fetchWorker(new Request("https://example.com/api"));
    expect(get.status).toBe(400);
    const bad = await fetchWorker(
      new Request("https://example.com/api", { method: "POST", body: "not json" })
    );
    expect(bad.status).toBe(400);
  });

  it("returns 404 off /api", async () => {
    const resp = await fetchWorker(new Request("https://example.com/other"));
    expect(resp.status).toBe(404);
  });
});
