# Allsfair Cloudflare Migration — Design

**Date:** 2026-07-06
**Status:** Approved pending review
**Goal:** Move the allsfair game off Google Cloud (Cloud Functions + BigQuery) onto Cloudflare (Workers + D1), served from a user-owned subdomain, at ~$0/month.

## Context

Current stack:

- **Backend:** one GCP Cloud Function (gen2, Python 3.12) exposing 4 POST actions: `create_game`, `join_game`, `submit_move`, `get_moves` (`main.py`, `actions.py`).
- **Database:** BigQuery used as a transactional store (`bq.py`) — wrong tool: per-query cost, ~1–2s latency, DML on an analytics warehouse.
- **Frontend:** single static `frontend/index.html` with `API_URL` pointing at the function.
- **Game engine:** separate `allsfair` Python package (~340 lines, pure stdlib), installed from GitHub.
- **ML bot:** optional play-against-bot mode; Q-table trained offline in Python, inference artifact is sharded JSON synced to GCS.

Decisions made during brainstorming:

- Host on Cloudflare (user already hosts there).
- Rewrite the serving path in TypeScript (stable Workers runtime; Python Workers is beta).
- **Drop the ML bot from v1** but design so it can be re-added soon with no schema or API change.
- Existing games in BigQuery are ephemeral and do **not** migrate.

## Architecture

One Cloudflare Worker with static assets, on one subdomain (e.g. `allsfair.<domain>`):

```
allsfair.<domain>  (domain already on Cloudflare; route set in wrangler config)
├── GET  /*     → static assets (index.html)
└── POST /api   → Worker fetch handler → action router → D1
```

- Frontend and API are same-origin, so all CORS/preflight handling in `main.py` is deleted, and `API_URL` in `index.html` becomes the relative path `/api`.
- Cloudflare free tier (Workers 100k req/day, D1 5M row-reads/day, 100k row-writes/day) covers hobby scale at $0. Overflow path is Workers Paid at a flat $5/month.

## Components

New top-level directory `allsfair-worker/` (sibling of `allsfair/` and `allsfair-python-function/`):

| File | Purpose |
|---|---|
| `src/engine.ts` | Port of `allsfair/models.py` + `exceptions.py`: `Board`, `Game`, `Move`, `MovePair`, move parsing/validation, pair resolution, restock. |
| `src/actions.ts` | Port of `actions.py` + `db.py`: the 4 actions, game/board reconstruction from move history. |
| `src/db.ts` | D1 queries (port of `bq.py`). |
| `src/index.ts` | Fetch handler: routes `POST /api` by `action` field, serves 400s for bad actions; static assets handled by the assets binding. |
| `public/index.html` | Moved from `frontend/index.html`; `API_URL = '/api'`. |
| `schema.sql` | D1 schema. |
| `wrangler.toml` | Worker config: assets binding, D1 binding, custom-domain route. |
| `test/` | vitest suite (see Testing). |

## Data model (D1)

Same logical schema as BigQuery, with one fix — move `id` was `int(time.time()*1000)` (collision-prone); D1 uses autoincrement:

```sql
CREATE TABLE games (
  game_guid        TEXT PRIMARY KEY,
  player_1_secret  TEXT NOT NULL,
  player_2_secret  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE moves (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  game_guid   TEXT NOT NULL,
  move_string TEXT NOT NULL,
  player      INTEGER NOT NULL
);
CREATE INDEX idx_moves_game ON moves(game_guid, id);
```

`ORDER BY id` semantics from `bq.py` are preserved (insertion order per game).

## API behavior

Unchanged from the current function: `POST /api` with JSON (or form) body `{action, ...}`; same action names, same request/response payloads, same status codes. The frontend keeps working with only the `API_URL` change. Engine validation errors (`ImproperlyFormattedMove`, `InvalidMove`) map to 400 with the error message, as today.

## ML bot seam (v1: dropped, re-add planned)

Not shipped in v1, but the port keeps re-adding it cheap:

- The `player_2_secret` prefix convention (`__ML_BOT__:`) and `isMlGame()` check are ported into `actions.ts`.
- `create_game` accepts `play_against_ml` but returns a 400 "not yet supported" in v1 (explicit, not silent).
- `submit_move` keeps the post-trio hook point where bot auto-submission slots in.

Re-adding the bot later = new `src/bot.ts` (state-key hashing, Q-table shard lookup, heuristic fallback — all pure-stdlib logic today, ~150 lines) + shipping the sharded JSON inference artifact as static assets the Worker fetches per lookup. No schema or API change. `ml/train.py` stays Python, offline, unchanged.

## Testing

Python engine remains the source of truth for game rules.

1. **Parity fixtures:** a small Python script in `allsfair/` replays curated move sequences through the Python engine and emits JSON fixtures (moves in → board state / errors out). The vitest suite replays the same sequences through `engine.ts` and asserts identical results. Catches port bugs mechanically.
2. **Action tests:** port the existing pytest coverage of `actions.py` to vitest, using a local D1 (miniflare/`wrangler dev` environment).
3. **Manual smoke:** `wrangler dev` locally, then a full PvP game on the deployed subdomain.

## Deployment

- `wrangler deploy` (manual, or later a GitHub Action; cloudbuild is gone).
- DNS: custom-domain route on the Worker via wrangler config — no manual record fiddling since the zone is already on Cloudflare.

## Decommission (after cutover verified)

- Delete Cloud Function, BigQuery dataset, GCS checkpoint bucket, `cloudbuild.yaml` trigger.
- In `allsfair-python-function/`: serving-path files (`main.py`, `bq.py`, `db.py`, `actions.py`, `settings.py`, `cloudbuild.yaml`, `frontend/`) become dead; repo remains home of the ML training code (`ml/`, `scripts/`, `checkpoints/`).

## Out of scope

- Migrating existing BigQuery game data.
- Bot play (v1) — see seam section.
- Any game-rule or frontend feature changes.
