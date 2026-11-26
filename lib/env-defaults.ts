// Defaults that lib/env.ts uses. They live apart from lib/env.ts because the database scripts
// (scripts/*.ts) run without Next, where lib/env.ts ("server-only") cannot load.
// bin/server.mjs and bin/emuly.mjs are plain JavaScript and repeat DEFAULT_PORT; lib/env-defaults.test.ts checks them.

/** The dev and self-host server port. */
export const DEFAULT_PORT = 4321;
/** The local SQLite file. */
export const DEFAULT_DB_PATH = ".data/emuly.db";
