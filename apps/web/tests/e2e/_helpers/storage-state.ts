import {fileURLToPath} from "node:url";

// The captured-session file the `setup` project writes and the `authed` project
// reads (ADR 0085). Gitignored and produced fresh per run — never committed.
// Single source of truth so setup + playwright.config.cjs can't drift apart.
// Resolved off this file's own URL (Playwright loads specs as ESM, so there is
// no `__dirname`): tests/e2e/_helpers/ → tests/e2e/.auth/user.json.
export const STORAGE_STATE = fileURLToPath(new URL("../.auth/user.json", import.meta.url));
