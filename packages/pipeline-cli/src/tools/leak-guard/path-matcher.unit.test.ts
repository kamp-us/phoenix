/**
 * `path-matcher` unit tests — the single source both leak-guard detectors import (#3506). These
 * pin the two SHAPE carve-outs that must apply uniformly to every consumer: the `~/.claude` public
 * config-file exemption (#3475/#3505) and the `/tmp/…-*.sock` machine-agnostic socket-glob
 * exemption (#3492). The detector-level tests (leak-guard.unit.test.ts / crew-leak.unit.test.ts)
 * assert the carve-outs reach their surfaces; these assert the shared shapes directly.
 */
import {assert, describe, it} from "@effect/vitest";
import {MACHINE_LOCAL_PATH_PATTERNS, TEMP_PATH_PATTERNS} from "./path-matcher.ts";

// A minimal any-pattern scan over an arm — mirrors what the consumers' scanners do (matchAll per
// pattern), reduced to a boolean for the assertions here.
const hits = (patterns: ReadonlyArray<{pattern: RegExp}>, text: string): boolean =>
	patterns.some((p) => text.match(p.pattern) !== null);

const hitsHome = (text: string): boolean => hits(MACHINE_LOCAL_PATH_PATTERNS, text);
const hitsTemp = (text: string): boolean => hits(TEMP_PATH_PATTERNS, text);

describe("MACHINE_LOCAL_PATH_PATTERNS — home/absolute arm", () => {
	describe("~/.claude public config-file carve-out (#3475/#3505)", () => {
		it("exempts the ~/.claude.json sibling dotfile", () =>
			assert.isFalse(hitsHome("registers the server into ~/.claude.json")));
		it("exempts the ~/.claude/settings.json config file", () =>
			assert.isFalse(hitsHome("edit ~/.claude/settings.json to add the crew server")));

		it("still flags a ~/.claude directory-internal path", () =>
			assert.isTrue(hitsHome("session log at ~/.claude/projects/foo/bar.jsonl")));
		it("still flags a bare ~/.claude directory reference", () =>
			assert.isTrue(hitsHome("the ~/.claude directory holds machine state")));
		it("still flags a config-file-lookalike leaf (settings.local.json / .claude.json.bak)", () => {
			assert.isTrue(hitsHome("local override at ~/.claude/settings.local.json"));
			assert.isTrue(hitsHome("backup at ~/.claude.json.bak"));
		});
	});

	describe("the rest of the arm is unchanged", () => {
		it("flags /Users/<name>, ~/.usirin, ~/.agent, ~/code/, /vault/", () => {
			assert.isTrue(hitsHome("see /Users/someone/code/x"));
			assert.isTrue(hitsHome("the vault lives at ~/.usirin/vault"));
			assert.isTrue(hitsHome("agent home ~/.agent/state"));
			assert.isTrue(hitsHome("rebuilt from ~/code/github.com/kamp-us/kampus"));
			assert.isTrue(hitsHome("stored under /vault/secrets"));
		});
		it("does NOT flag a Windows drive-prefixed C:/Users/... URL (#3070)", () =>
			assert.isFalse(hitsHome("file:///C:/Users/ci/proj/x")));
		it("does NOT flag benign ~/.config or ~/Documents", () => {
			assert.isFalse(hitsHome("credentials in ~/.config/kampus/creds"));
			assert.isFalse(hitsHome("saved to ~/Documents/report.pdf"));
		});
	});
});

describe("TEMP_PATH_PATTERNS — /tmp/…-*.sock glob carve-out (#3492)", () => {
	it("exempts a username-free, *-globbed socket name", () => {
		assert.isFalse(hitsTemp("the inbox is /tmp/kampus-crew-inbox-*.sock"));
		assert.isFalse(hitsTemp("bind /tmp/some-service-*.sock for the fan-out"));
	});

	it("still flags a concrete /tmp/<name> scratch path (no glob)", () => {
		assert.isTrue(hitsTemp("staged at /tmp/alice-scratch/verdict.md"));
		assert.isTrue(hitsTemp("wrote /tmp/write-code-progress.md"));
		// a concrete socket without a glob is machine-local — still flags
		assert.isTrue(hitsTemp("bound /tmp/kampus-crew-inbox.sock"));
	});
	it("still flags a globbed path that descends into a directory (could hide a username)", () =>
		assert.isTrue(hitsTemp("under /tmp/alice/*.sock")));
	it("still flags a .sock backup leaf (the exemption is pinned to the terminal leaf)", () =>
		assert.isTrue(hitsTemp("stale /tmp/kampus-crew-inbox-*.sock.bak")));
	it("still flags the mktemp roots (/var/folders, /private/tmp)", () => {
		assert.isTrue(hitsTemp("/var/folders/8f/T/tmp.abc"));
		assert.isTrue(hitsTemp("/private/tmp/claude/scratchpad/verdict.md"));
	});
});
