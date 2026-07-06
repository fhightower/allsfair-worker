// Fetch handler: static assets are served by the platform's assets binding
// before the worker runs, so this only ever sees non-asset requests.
import {
  createGame,
  getMoves,
  joinGame,
  submitMove,
  type ResponseContent,
} from "./actions";
import { ActionError } from "./errors";
import { BaseAllsfairError } from "./exceptions";

export interface Env {
  DB: D1Database;
}

type ActionHandler = (
  db: D1Database,
  body: Record<string, unknown>
) => Promise<ResponseContent>;

const actionHandlers: Record<string, ActionHandler> = {
  create_game: createGame,
  join_game: joinGame,
  submit_move: submitMove,
  get_moves: getMoves,
};

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/api") {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "POST") {
      return new Response("Invalid request", { status: 400 });
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json<Record<string, unknown>>();
    } catch {
      return new Response("Invalid JSON body", { status: 400 });
    }

    const handler = actionHandlers[String(body.action)];
    if (!handler) {
      return new Response(`Invalid action: ${body.action}`, { status: 400 });
    }

    try {
      const content = await handler(env.DB, body);
      return Response.json(content);
    } catch (error) {
      if (error instanceof BaseAllsfairError || error instanceof ActionError) {
        return new Response(error.message, { status: 400 });
      }
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;
