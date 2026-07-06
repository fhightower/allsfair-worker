// Port of allsfair/exceptions.py — message texts must stay identical, the
// frontend displays them verbatim.
export const PROPER_MOVE_GUIDE =
  "A valid move must have the form: {STARTING SQUARE}{TROOP COUNT}{ENDING SQUARE} like 'a1b' or 'i42h'.";

export class BaseAllsfairError extends Error {}

export class ImproperlyFormattedMove extends BaseAllsfairError {
  constructor(moveStr: string) {
    super(`Improperly formatted move: '${moveStr}'. ${PROPER_MOVE_GUIDE}`);
  }
}

export class InvalidMove extends BaseAllsfairError {
  constructor(moveStr: string) {
    super(`Invalid move: '${moveStr}'.`);
  }
}

export class InvalidSecret extends BaseAllsfairError {
  constructor() {
    super("Invalid secret");
  }
}
