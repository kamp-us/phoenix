/**
 * Golden real-payload fixture loader (ADR 0180).
 *
 * A hook/harness handler's contract is defined by the runtime and only observable at
 * execution, so its test asserts against a *captured real payload* committed as a golden
 * fixture — never a hand-authored shape (that is exactly how #2925 shipped a hook built to
 * a fabricated `worktree_path` that the harness never sends). This is the one helper that
 * reads such a fixture verbatim: the raw bytes it returns are the same bytes fed to the
 * handler's stdin, so the fixture — not inline test code — is the assertion path's input.
 *
 * `baseUrl` is the caller's `import.meta.url`; `name` is the fixture path relative to it
 * (by convention `__fixtures__/<handler>.payload.golden.json`), so a handler co-locates its
 * captured payload next to its test. Reusable across every hook/harness handler in the CLI.
 */
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";

/** Read a committed golden real-payload fixture verbatim (the raw JSON text). ADR 0180. */
export const readGoldenFixture = (baseUrl: string | URL, name: string): string =>
	readFileSync(fileURLToPath(new URL(name, baseUrl)), "utf8");

/** Parse a golden fixture into an untyped record — for asserting the captured payload's shape. */
export const loadGoldenPayload = (baseUrl: string | URL, name: string): Record<string, unknown> =>
	JSON.parse(readGoldenFixture(baseUrl, name)) as Record<string, unknown>;
