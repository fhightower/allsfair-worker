# Allsfair Search Bot — Design

**Date:** 2026-07-10
**Status:** Approved pending review
**Goal:** Ship play-against-bot in the Cloudflare Worker: a non-LLM, asset-free bot that runs locally and in the cloud and is materially stronger than the retired GCP bot.

## Context

The migration spec (`2026-07-06-cloudflare-migration-design.md`) shipped v1 without the bot but kept its seam: the `__ML_BOT__` secret convention, `isMlGame()`, ML guards in `join_game`/`submit_move`, and the auto-submission hook point in `submitMove`. This spec fills that seam.

### Measured strength data (Python eval harness, 2026-07-10)

| Matchup | Result |
|---|---|
| Q-table alone vs heuristic | 34% W / 62% L |
| Hybrid (Q + heuristic fallback — the old deployed bot) vs heuristic | 93% W |
| **Search bot vs heuristic** (100 games) | **76% W / 14% L / 10% D** |
| **Search bot vs hybrid** (50 games) | **94% W / 1 L** |

The user easily beat the hybrid; the search bot beats the hybrid 94% of the time. The 301 MB Q-table artifact is dead weight and is not used.

Prototype used for these numbers: committed to the `allsfair` repo as `scripts/search_bot_eval.py` (tuning/eval harness; re-run after any weight change).

## Bot brain (`src/bot.ts`)

Trio-level candidate search, a direct port of the measured prototype. Planning happens from the **round-start board** — the bot never reads player 1's already-submitted moves for the current round (fair simultaneous play).

1. **Heuristic action scoring** (port of `ml/opponents.py`): for each legal action — advance-toward-enemy-home ×1.2, troops ×0.08, capture value min(troops, defenders) ×0.6 (+1.0 if troops ≥ defenders), empty-square +0.45, enemy-home-entry +1.5.
2. **Legal actions** (port of `ml/action_space.py`): each populated owned square × each neighbor × troop options 1..min(count, 8), plus the full count when count > 8.
3. **Candidate trios (N=16):** 1 pure-heuristic trio (argmax each slot) + 15 diversified trios (each slot sampled uniformly from the top-3 scored actions), planned on an optimistically-advanced clone, then deduped. No legal actions in a slot → pass move `i0h` (0 troops = engine no-op).
4. **Opponent model (K=6):** same trio sampler for player 1 (1 argmax + 5 top-3 samples).
5. **Scoring:** each candidate × each opponent trio → simulate the full round with the real engine (`applyMovePair` ×3, stop early on winner, then `restock`) → evaluate. Trio score = 0.25 × min + 0.75 × mean over opponent trios. Highest score wins.
6. **Evaluation function** (bot perspective; weights as measured):
   - win/loss: ±1,000,000
   - material (my troops − theirs) ×3
   - populated squares diff ×2
   - progress ×0.6: Σ troops × (4 − BFS distance to enemy home), mine minus theirs
   - home exposure ×1.5: enemy troops within distance ≤2 of my home, proximity-weighted ×2, minus my home garrison, floored at 0; +50 flat if my home is enemy-owned
   - enemy-home-capture bonus +6
7. **Determinism:** RNG seeded from `game_guid:completedRounds` via cyrb128 → mulberry32. Same game + round → same trio. No `Date.now()`/`Math.random()`. No cross-language parity requirement with the Python prototype — only internal determinism.

Compute per bot turn: ≤16×6 = 96 round simulations of ≤3 pairs — sub-millisecond; no assets, no cold-start cost, runs identically in workerd, node tests, and `wrangler dev`.

BFS distances and the mirror map are constants (port of `ml/constants.py`); the 9-node board is fixed, so they may be precomputed literals with a test asserting they match a BFS over `startingBoardState()`.

## Server wiring (`src/actions.ts`)

Port of the dormant Python hooks (`actions.py` `_generate_ml_moves_if_needed`, `db.py` `get_ml_round_context`):

- `create_game` with `play_against_ml` truthy → `player_2_secret = "__ML_BOT__:" + crypto.randomUUID()`; the v1 400 response is removed. Response `play_against_ml: true`.
- New `src/db.ts` function `getMlRoundContext(db, gameGuid, roundIndex)` → round-start board (replay `roundIndex × 3` pairs with restock every 3rd) + bot moves already written for that round.
- `generateMlMovesIfNeeded(db, gameGuid, roundState)`: while no winner AND `p1Count % 3 === 0` AND `p1Count > p2Count` AND p1 has finished the round the bot is entering: plan trio from round-start board, write only the bot moves not already persisted (idempotent under concurrent polling), refresh round state. Runs after player 1's `submit_move` and inside `get_moves` for player 1 (recovery path). Both existing guards stay: `join_game` refuses ML games; `submit_move` refuses `player === "2"` on ML games.

No D1 schema change. No API shape change (`play_against_ml` already in `ResponseContent`).

## Frontend (`public/index.html`)

Remove `style="display:none"` from the `.mode-toggle` div — one-line revert; all bot-game flow (checkbox, `play_against_ml` in responses, localStorage) already exists.

## Testing

- **Unit (`test/bot.test.ts`):** legal-action enumeration matches spec (incl. >8 troop option); heuristic argmax picks an obvious capture; trio planner returns 3 valid move strings; pass fallback when bot has no populated squares; determinism (same guid+round → identical trio; different round → RNG advances).
- **Constants:** precomputed distance tables equal BFS over `startingBoardState()`.
- **Strength gate (`test/bot.strength.test.ts`):** 50 seeded games search-vs-heuristic (both TS) via direct engine loop; assert ≥60% search wins (measured 76%; margin absorbs variance). Also search vs uniform-random: assert ≥90% wins. Fast (<1s).
- **Actions (`test/actions.test.ts` additions):** ML create_game sets prefix + returns `play_against_ml: true`; P1 trio → response has 3 bot moves and `round_complete: true`; repeated `get_moves` polls don't duplicate bot moves; join/submit-as-P2 guards still refuse; multi-round bot game reaches round 2 correctly.
- **Deploy smoke:** full bot game via the production API.

## Out of scope

- Difficulty levels, Q-table/hybrid revival (artifact stays in `allsfair` repo checkpoints), deeper search, bot-vs-bot spectator mode.
- Removing the old `ml/backend_bot.py` Python path (harmless, still used by the eval harness).
