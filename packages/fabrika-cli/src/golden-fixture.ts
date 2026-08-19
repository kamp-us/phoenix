/**
 * Read a committed golden real-payload fixture verbatim (ADR 0180).
 *
 * A hook handler's contract is defined by the runtime and only observable at execution, so its test
 * asserts against a *captured* payload committed as a fixture — never a hand-authored shape. The
 * bytes this returns are the same bytes fed to the handler's stdin, so the fixture, not inline test
 * code, is the assertion path's input.
 *
 * Reimplemented rather than reused: v1's CLI has the same helper, and ADR 0238 bans
 * calling v1 — the scar is duplicated as behaviour, not as a dependency.
 *
 * The raw `node:fs`/`node:url` is deliberate: this is test-only scaffolding whose whole point is the
 * real committed file on disk, and `fileURLToPath` has no `Path` equivalent — both sit on
 * `.patterns/effect-platform-access.md`'s bright line.
 */
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";

/** `baseUrl` is the caller's `import.meta.url`; `name` is the fixture path relative to it. */
export const readGoldenFixture = (baseUrl: string | URL, name: string): string =>
	readFileSync(fileURLToPath(new URL(name, baseUrl)), "utf8");

/** Parse a golden fixture into an untyped record — for asserting the captured payload's shape. */
export const loadGoldenPayload = (baseUrl: string | URL, name: string): Record<string, unknown> =>
	JSON.parse(readGoldenFixture(baseUrl, name)) as Record<string, unknown>;
