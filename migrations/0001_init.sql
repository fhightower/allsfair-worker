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
