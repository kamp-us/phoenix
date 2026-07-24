/**
 * `path-matcher` unit tests — the single source both leak-guard detectors import (#3506). These
 * pin the one SHAPE carve-out that must apply uniformly to every consumer: the `~/.claude` public
 * config-file exemption (#3475/#3505). The `/tmp` arm has NO carve-out (#3492 Option 1 — the socket
 * false positive is fixed emit-side, not by weakening the guard), so it fail-closes on ANY bare
 * `/tmp/…`. The detector-level tests (leak-guard.unit.test.ts / crew-leak.unit.test.ts) assert the
 * carve-out reaches their surfaces; these assert the shared shapes directly.
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

	// The generic `~/<root>/<host>/<user>/<repo>` sibling-clone arm (#3401): the `~/code/`-only arm
	// missed clones rooted anywhere else. Keyed on the forge-host segment SHAPE, not a named root/host
	// deny-list (#2393), and the `<user>/<repo>` tail keeps benign single-purpose home subdirs safe.
	describe("generic home-relative sibling-repo clone arm (#3401)", () => {
		it("flags the incident shape and clones rooted anywhere, on any forge host", () => {
			// The literal PR #3360 review-thread reply leak.
			assert.isTrue(hitsHome("grounded in ~/code/github.com/usirin/effect-smol"));
			// The gap the `~/code/`-only arm missed: clones under other roots.
			assert.isTrue(hitsHome("cloned at ~/dev/github.com/usirin/alchemy-effect"));
			assert.isTrue(hitsHome("see ~/projects/github.com/kamp-us/phoenix/README.md"));
			assert.isTrue(hitsHome("under ~/src/github.com/effect-ts/effect"));
			assert.isTrue(hitsHome("in ~/work/gitlab.com/team/service"));
			assert.isTrue(hitsHome("~/repos/bitbucket.org/acme/widget"));
		});
		it("does NOT flag benign home subdirs with no <host>/<user>/<repo> clone shape", () => {
			assert.isFalse(hitsHome("saved to ~/Documents/report.pdf"));
			assert.isFalse(hitsHome("state under ~/.config/kampus/creds"));
			// A ~/Library reverse-DNS bundle path — why the arm is single-root, not multi-segment.
			assert.isFalse(hitsHome("cache at ~/Library/Caches/com.apple.Safari/data"));
		});
	});
});

describe("TEMP_PATH_PATTERNS — fail-close on ANY bare /tmp (no carve-out, #3492 Option 1)", () => {
	it("flags the socket glob (#3492 — the fix is emit-side, the guard stays strict)", () => {
		assert.isTrue(hitsTemp("the inbox is /tmp/kampus-crew-inbox-*.sock"));
		assert.isTrue(hitsTemp("bind /tmp/some-service-*.sock for the fan-out"));
	});
	it("flags a concrete /tmp/<name> scratch path", () => {
		assert.isTrue(hitsTemp("staged at /tmp/alice-scratch/verdict.md"));
		assert.isTrue(hitsTemp("wrote /tmp/write-code-progress.md"));
		assert.isTrue(hitsTemp("bound /tmp/kampus-crew-inbox.sock"));
	});
	it("flags the mktemp roots (/var/folders, /private/tmp)", () => {
		assert.isTrue(hitsTemp("/var/folders/8f/T/tmp.abc"));
		assert.isTrue(hitsTemp("/private/tmp/claude/scratchpad/verdict.md"));
	});
});
