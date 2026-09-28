import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import type {AccentDeclaration} from "../capture/accent.ts";
import {PREVIEW_AUTH_KEY_PATH, signSessionToken} from "../capture/auth.ts";
import type {SchemeDeclaration} from "../capture/color-scheme.ts";
import type {LocaleDeclaration} from "../capture/locale-seed.ts";
import type {UiSurface} from "../config/keys/ui-surfaces.ts";
import {fakeFs, fakeSeams, type HttpReply, type Scripted} from "../fakes.test-support.ts";
import {
	INVALID_CAPTURE,
	NO_PREVIEW,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	RENDER_CRASHED,
	STALE_TREE,
	SURFACE_UNREACHABLE,
	WRONG_VIEWPORT,
	ZERO_SCOPE,
} from "./codes.ts";
import {parseManifest} from "./manifest.ts";
import {type CaptureShots, makeCaptureRenderLeg} from "./render-leg.ts";
import {type RenderLeg, runRender, type SurfaceRender} from "./render-verb.ts";

const HEAD = "03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c";
const PREVIEW = "https://pr-4321-web.example.test";

const PULL = /GET .*\/repos\/o\/r\/pulls\/4321\b/;
const COMMENTS = /GET .*\/repos\/o\/r\/issues\/4321\/comments/;

const pull = (state = "open", head = HEAD): HttpReply => ({
	status: 200,
	body: JSON.stringify({
		number: 4321,
		state,
		head: {sha: head},
		base: {ref: "main"},
		body: "",
		changed_files: 2,
		comments: 1,
	}),
});

const announcement = (sha: string = HEAD.slice(0, 7)): HttpReply => ({
	status: 200,
	body: JSON.stringify([
		{
			id: 7,
			user: {login: "kampus-bot"},
			created_at: "2026-08-09T00:00:00Z",
			updated_at: "2026-08-09T00:00:00Z",
			body: `<!-- preview-deploy:web -->\n- **web** — Stage \`pr-4321\` → ${PREVIEW} <sub>(${sha})</sub>`,
		},
	]),
});

const rendered = (
	surface: string,
	outDir: string,
	viewport = "desktop",
	width = 1280,
): SurfaceRender => ({
	_tag: "Rendered",
	entry: {
		surface,
		viewport,
		path: `${outDir}/${surface.replace(/^\//, "")}@${viewport}.png`,
		width,
		height: 2140,
		sha256: "9c41",
		pageErrors: {rows: [], more: 0},
	},
});

/** A leg that answers per surface, so a mixed set is as expressible as a clean one. */
const legOf =
	(answers: Readonly<Record<string, SurfaceRender>>): RenderLeg =>
	(request) =>
		Effect.succeed(
			answers[request.surface] ??
				rendered(request.surface, request.outDir, request.viewport.label, request.viewport.width),
		);

const row = (name: string, mount: string): UiSurface => ({
	name,
	prefix: `apps/${name.split("-")[0]}/src/`,
	command: "pnpm dev --port {{port}}",
	mount,
	basePath: null,
	readyPath: "/",
});

/** Two apps over one namespace, with web's catch-all mount declared ahead of the deeper desk one. */
const ROWS: ReadonlyArray<UiSurface> = [
	row("web", "/"),
	row("web-lab", "/lab"),
	row("desk-board", "/desk/board"),
];

const options = {
	pr: 4321,
	out: "judged",
	surfaces: ["/pano"],
	viewports: [] as readonly string[],
	flags: [] as readonly string[],
	locale: null as string | null,
	localeDeclaration: null as LocaleDeclaration | null,
	schemes: [] as readonly string[],
	schemeDeclaration: null as SchemeDeclaration | null,
	accent: null as string | null,
	accentDeclaration: null as AccentDeclaration | null,
	interactions: [] as readonly string[],
	app: null,
	surfaceRows: ROWS,
	authSecretFrom: null as string | null,
	// A directory in no package tree, so the committed-preview-key source finds nothing and the
	// ambient fallback is what these cases exercise. The cases that mean to read the committed key
	// override this with `/repo`, whose fake tree carries the file.
	cwd: "/work",
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
	tmpRoot: "/tmp",
	render: legOf({}),
};

const run = (
	script: ReadonlyArray<Scripted>,
	overrides: Partial<typeof options> = {},
	files: Readonly<Record<string, string>> = {},
	unreadable: ReadonlyArray<string> = [],
) => {
	const fs = fakeFs({files, unreadable: [...unreadable]});
	return Effect.runPromise(
		Effect.provide(
			runRender({...options, ...overrides}),
			Layer.merge(fakeSeams(script).layer, fs.layer),
		),
	).then((outcome) => ({outcome, written: fs.written}));
};

const happy = (): ReadonlyArray<Scripted> => [
	[PULL, pull()],
	[COMMENTS, announcement()],
];

describe("runRender", () => {
	it("captures the surface, prints the manifest, and writes the same bytes to the set", async () => {
		const {outcome, written} = await run(happy());
		expect(outcome.code).toBe(0);
		const manifest = parseManifest(outcome.stdout);
		expect(manifest._tag).toBe("Manifest");
		expect(written.get("/tmp/fabrika-review-ui/4321-03135b91/judged/manifest.json")).toBe(
			outcome.stdout.trimEnd(),
		);
	});

	it("prints the capped page errors on both channels, so the file reader cannot desync", async () => {
		const noisy: SurfaceRender = {
			_tag: "Rendered",
			entry: {
				surface: "/pano",
				viewport: "desktop",
				path: "/tmp/fabrika-review-ui/4321-03135b91/judged/pano@desktop.png",
				width: 1280,
				height: 2140,
				sha256: "9c41",
				pageErrors: {rows: [{kind: "console.error", text: "Warning: a"}], more: 12},
			},
		};
		const {outcome, written} = await run(happy(), {render: legOf({"/pano": noisy})});
		expect(outcome.code).toBe(0);
		const read = parseManifest(outcome.stdout);
		expect(read).toMatchObject({
			_tag: "Manifest",
			value: {captures: [{pageErrors: {rows: [{text: "Warning: a"}], more: 12}}]},
		});
		expect(outcome.stdout).not.toContain('"pageErrors":[');
		expect(written.get("/tmp/fabrika-review-ui/4321-03135b91/judged/manifest.json")).toBe(
			outcome.stdout.trimEnd(),
		);
		// The stderr tally is the whole list, not the kept rows — the collapse must not shrink the count.
		expect(outcome.stderr).toContain(
			'review-ui render: surface "/pano" at desktop captured: 1280x2140, 13 page error(s)',
		);
	});

	it("enumerates every surface's outcome on stderr, success included", async () => {
		const {outcome} = await run(happy(), {surfaces: ["/pano", "/pano/yeni"]});
		expect(outcome.code).toBe(0);
		expect(outcome.stderr.filter((line) => line.includes("captured:"))).toHaveLength(2);
	});

	it("refuses zero surfaces — `rendered nothing, found nothing wrong` is not an answer", async () => {
		const {outcome} = await run(happy(), {surfaces: []});
		expect(outcome.code).toBe(1);
	});

	it("refuses a non-kebab --out and an unrealized :state suffix on 10", async () => {
		expect((await run(happy(), {out: "Judged"})).outcome.code).toBe(OFF_VOCABULARY);
		expect((await run(happy(), {surfaces: ["/pano:empty"]})).outcome.code).toBe(OFF_VOCABULARY);
	});

	// An `:auth` surface rendered anonymously is the "unseen ground reading as clean" defect, so a
	// half-set or absent credential pair is UNKNOWN rather than a visitor's shot.
	it("refuses an :auth surface with no credentials on 11, never the anonymous render", async () => {
		expect((await run(happy(), {surfaces: ["/pano:auth"]})).outcome.code).toBe(
			PRECONDITION_UNKNOWN,
		);
		const halfSet = await run(happy(), {
			surfaces: ["/pano:auth"],
			env: {CLAUDE_PIPELINE_REPO: "o/r", PREVIEW_TEST_SESSION_TOKEN: "t".repeat(32)},
		});
		expect(halfSet.outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(halfSet.outcome.stderr.join("\n")).toContain("BETTER_AUTH_SECRET");
	});

	/**
	 * The defect this closes: the seat's `.env` carries the example file's throwaway key, the
	 * cookie signs cleanly, and the preview worker — deployed with the real repo-wide secret —
	 * answers it as a visitor. Two gate rounds read that as an unseeded preview, because a bad
	 * signature and an absent session row are the same bare `null` from better-auth.
	 */
	it("refuses a placeholder-prefixed ambient secret on 11 rather than signing a cookie the worker rejects", async () => {
		const {outcome} = await run(happy(), {
			surfaces: ["/pano:auth"],
			env: {
				CLAUDE_PIPELINE_REPO: "o/r",
				PREVIEW_TEST_SESSION_TOKEN: "t".repeat(32),
				BETTER_AUTH_SECRET: "insecure_f0fe1c42",
			},
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		const said = outcome.stderr.join("\n");
		expect(said).toContain("insecure_");
		expect(said).toContain("$BETTER_AUTH_SECRET");
		// The route out is the committed preview key, never a credential the seat has to be handed
		// — this checkout simply carries no such file.
		expect(said).toContain(PREVIEW_AUTH_KEY_PATH);
		expect(said).not.toContain("ALCHEMY_PASSWORD");
	});

	/**
	 * The route the whole ruling exists to open: a seat holding no credential at all renders an
	 * `:auth` surface, because the key its preview verifies against is committed in the repo.
	 */
	it("signs with the committed preview key, with no flag and no ambient secret", async () => {
		const seen = new Map<string, readonly {name: string; value: string}[]>();
		const {outcome} = await run(
			happy(),
			{
				surfaces: ["/pano:auth"],
				cwd: "/repo",
				env: {CLAUDE_PIPELINE_REPO: "o/r", PREVIEW_TEST_SESSION_TOKEN: "t".repeat(32)},
				render: (request) => {
					seen.set(request.surface, request.cookies);
					return Effect.succeed(rendered(request.surface, request.outDir));
				},
			},
			{
				"/repo/package.json": "{}",
				[`/repo/${PREVIEW_AUTH_KEY_PATH}`]: "preview_0f1e2d3c4b5a69788796a5b4c3d2e1f0\n",
			},
		);
		expect(outcome.code).toBe(0);
		expect(seen.get("/pano:auth")?.[0]?.value).toBe(
			signSessionToken("t".repeat(32), "preview_0f1e2d3c4b5a69788796a5b4c3d2e1f0"),
		);
	});

	it("prefers the committed preview key over a usable ambient secret", async () => {
		const seen = new Map<string, readonly {name: string; value: string}[]>();
		await run(
			happy(),
			{
				surfaces: ["/pano:auth"],
				cwd: "/repo",
				env: {
					CLAUDE_PIPELINE_REPO: "o/r",
					PREVIEW_TEST_SESSION_TOKEN: "t".repeat(32),
					BETTER_AUTH_SECRET: "a".repeat(32),
				},
				render: (request) => {
					seen.set(request.surface, request.cookies);
					return Effect.succeed(rendered(request.surface, request.outDir));
				},
			},
			{
				"/repo/package.json": "{}",
				[`/repo/${PREVIEW_AUTH_KEY_PATH}`]: "preview_0f1e2d3c4b5a69788796a5b4c3d2e1f0\n",
			},
		);
		// The ambient variable is a seat's guess at what some stage deploys with; the committed key
		// is what this preview provably deploys with, so it wins.
		expect(seen.get("/pano:auth")?.[0]?.value).toBe(
			signSessionToken("t".repeat(32), "preview_0f1e2d3c4b5a69788796a5b4c3d2e1f0"),
		);
	});

	it("lets --auth-secret-from override the committed preview key", async () => {
		const seen = new Map<string, readonly {name: string; value: string}[]>();
		await run(
			happy(),
			{
				surfaces: ["/pano:auth"],
				cwd: "/repo",
				authSecretFrom: "/run/named-secret",
				env: {CLAUDE_PIPELINE_REPO: "o/r", PREVIEW_TEST_SESSION_TOKEN: "t".repeat(32)},
				render: (request) => {
					seen.set(request.surface, request.cookies);
					return Effect.succeed(rendered(request.surface, request.outDir));
				},
			},
			{
				"/repo/package.json": "{}",
				[`/repo/${PREVIEW_AUTH_KEY_PATH}`]: "preview_0f1e2d3c4b5a69788796a5b4c3d2e1f0\n",
				"/run/named-secret": `${"d".repeat(32)}\n`,
			},
		);
		expect(seen.get("/pano:auth")?.[0]?.value).toBe(
			signSessionToken("t".repeat(32), "d".repeat(32)),
		);
	});

	it("signs with the exported repo-wide secret when --auth-secret-from names it", async () => {
		const seen = new Map<string, readonly {name: string; value: string}[]>();
		const {outcome} = await run(
			happy(),
			{
				surfaces: ["/pano:auth"],
				authSecretFrom: "/run/preview-secret",
				env: {
					CLAUDE_PIPELINE_REPO: "o/r",
					PREVIEW_TEST_SESSION_TOKEN: "t".repeat(32),
					BETTER_AUTH_SECRET: "insecure_f0fe1c42",
				},
				render: (request) => {
					seen.set(request.surface, request.cookies);
					return Effect.succeed(rendered(request.surface, request.outDir));
				},
			},
			{"/run/preview-secret": `${"d".repeat(32)}\n`},
		);
		expect(outcome.code).toBe(0);
		// The named source wins over the ambient placeholder, which is the whole point of the flag.
		const value = seen.get("/pano:auth")?.[0]?.value;
		expect(value).toBe(signSessionToken("t".repeat(32), "d".repeat(32)));
	});

	/**
	 * "I could not look" and "there is no repo here" are two facts, and only the second one is the
	 * ambient fallback's case. An unreadable ancestor folded into that arm would refuse on the
	 * ambient variable being empty and never mention the directory that actually stopped the read.
	 */
	it("refuses on 11 naming the unreadable ancestor when the repo root cannot be located", async () => {
		const {outcome} = await run(
			happy(),
			{
				surfaces: ["/pano:auth"],
				cwd: "/repo",
				env: {CLAUDE_PIPELINE_REPO: "o/r", PREVIEW_TEST_SESSION_TOKEN: "t".repeat(32)},
			},
			{"/repo/package.json": "{}"},
			["/repo/package.json"],
		);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		const said = outcome.stderr.join("\n");
		expect(said).toContain("/repo/package.json");
		expect(said).toContain("the repo root could not be located");
		expect(said).not.toContain("$BETTER_AUTH_SECRET");
	});

	it("refuses an unreadable --auth-secret-from on 11, naming the path", async () => {
		const {outcome} = await run(happy(), {
			surfaces: ["/pano:auth"],
			authSecretFrom: "/run/absent-secret",
			env: {CLAUDE_PIPELINE_REPO: "o/r", PREVIEW_TEST_SESSION_TOKEN: "t".repeat(32)},
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("/run/absent-secret");
	});

	// An anonymous run signs nothing, so a secret it never needs must not be able to refuse it.
	it("renders an anonymous surface with a placeholder secret in the environment", async () => {
		const {outcome} = await run(happy(), {
			env: {CLAUDE_PIPELINE_REPO: "o/r", BETTER_AUTH_SECRET: "insecure_f0fe1c42"},
		});
		expect(outcome.code).toBe(0);
	});

	it("seeds the session cookie onto the :auth surface only, so the default stays the visitor's", async () => {
		const seen = new Map<string, number>();
		const {outcome} = await run(happy(), {
			surfaces: ["/pano", "/pano:auth"],
			env: {
				CLAUDE_PIPELINE_REPO: "o/r",
				PREVIEW_TEST_SESSION_TOKEN: "t".repeat(32),
				BETTER_AUTH_SECRET: "s".repeat(32),
			},
			render: (request) => {
				seen.set(request.surface, request.cookies.length);
				return Effect.succeed(rendered(request.surface, request.outDir));
			},
		});
		expect(outcome.code).toBe(0);
		expect(seen.get("/pano")).toBe(0);
		expect(seen.get("/pano:auth")).toBe(2);
	});

	// A tier with no token of its own is a tier `preview-seed test-account` did not seed on this
	// preview. Reading it as satisfied by the yazar's token would render the audience the surface
	// said it was not, and the capture would come back clean.
	it("refuses a çaylak surface whose tier token is unset, naming it rather than falling back", async () => {
		const {outcome} = await run(happy(), {
			surfaces: ["/hosgeldin:auth-caylak"],
			env: {
				CLAUDE_PIPELINE_REPO: "o/r",
				PREVIEW_TEST_SESSION_TOKEN: "t".repeat(32),
				BETTER_AUTH_SECRET: "s".repeat(32),
			},
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("PREVIEW_TEST_CAYLAK_SESSION_TOKEN");
	});

	it("seeds each tier's own session, so two tiers are two identities and not one shot twice", async () => {
		const seen = new Map<string, string | undefined>();
		const {outcome} = await run(happy(), {
			surfaces: ["/hosgeldin:auth", "/hosgeldin:auth-caylak"],
			env: {
				CLAUDE_PIPELINE_REPO: "o/r",
				PREVIEW_TEST_SESSION_TOKEN: "t".repeat(32),
				PREVIEW_TEST_CAYLAK_SESSION_TOKEN: "c".repeat(32),
				BETTER_AUTH_SECRET: "s".repeat(32),
			},
			render: (request) => {
				seen.set(request.surface, request.cookies[0]?.value);
				return Effect.succeed(rendered(request.surface, request.outDir));
			},
		});
		expect(outcome.code).toBe(0);
		expect(seen.get("/hosgeldin:auth")).not.toBe(seen.get("/hosgeldin:auth-caylak"));
	});

	// The credential check only proves each tier's token was SET. Which tier actually rendered is the
	// shot's own answer, and a shot that came back above the named floor is UNKNOWN — the page
	// rendered fine, it is just not the audience the surface id named.
	it("refuses a wrong-tier shot on 11, recording no capture under that surface id", async () => {
		const {outcome, written} = await run(happy(), {
			surfaces: ["/hosgeldin:auth-caylak"],
			env: {
				CLAUDE_PIPELINE_REPO: "o/r",
				PREVIEW_TEST_CAYLAK_SESSION_TOKEN: "c".repeat(32),
				BETTER_AUTH_SECRET: "s".repeat(32),
			},
			render: legOf({
				"/hosgeldin:auth-caylak": {_tag: "WrongTier", wanted: "çaylak", rendered: "yazar"},
			}),
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("named tier çaylak and rendered as yazar");
		expect(written.size).toBe(0);
	});

	// The credential check only proves the pair was SET. Whether the cookie actually authenticated is
	// the shot's own answer, and a shot that came back a visitor's is UNKNOWN — never a red surface,
	// because the page rendered fine, and never a Rendered entry under the `:auth` id.
	it("refuses an :auth shot that did not render signed in on 11, recording no capture", async () => {
		const {outcome, written} = await run(happy(), {
			surfaces: ["/pano:auth"],
			env: {
				CLAUDE_PIPELINE_REPO: "o/r",
				PREVIEW_TEST_SESSION_TOKEN: "t".repeat(32),
				BETTER_AUTH_SECRET: "s".repeat(32),
			},
			render: legOf({
				"/pano:auth": {
					_tag: "Unauthenticated",
					reason: "the preview answered the seeded cookie as a visitor",
				},
			}),
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(written.size).toBe(0);
		expect(outcome.stderr.at(-1)).toMatch(/did not render signed in/);
	});

	// Routed ahead of the proven-red codes: a fine PNG of the wrong page is not a defect in the PR.
	it("routes an unauthenticated surface as UNKNOWN even beside a crashed one", async () => {
		const {outcome} = await run(happy(), {
			surfaces: ["/a:auth", "/b"],
			env: {
				CLAUDE_PIPELINE_REPO: "o/r",
				PREVIEW_TEST_SESSION_TOKEN: "t".repeat(32),
				BETTER_AUTH_SECRET: "s".repeat(32),
			},
			render: legOf({
				"/a:auth": {_tag: "Unauthenticated", reason: "probe answered 500"},
				"/b": {_tag: "Crashed", firstError: "TypeError: x is null"},
			}),
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});

	// The operand's own refusals, decided before a browser launches. Both are `10`: an operand
	// nothing can force and an operand the preview would silently drop are the same defect — the
	// default state shot under the forced name.
	it("refuses a malformed --flag operand on 10, naming the token and why", async () => {
		const {outcome} = await run(happy(), {surfaces: ["/pano:auth"], flags: ["welcome-banner"]});
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.join("\n")).toContain("no = separating the key from its value");
		expect((await run(happy(), {surfaces: ["/pano:auth"], flags: ["a=true"]})).outcome.code).toBe(
			OFF_VOCABULARY,
		);
	});

	it("refuses --flag beside an anonymous surface on 10 — the preview would drop the cookie", async () => {
		const {outcome} = await run(happy(), {
			surfaces: ["/pano:auth", "/hosgeldin"],
			flags: ["welcome-banner=on"],
		});
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.join("\n")).toContain('anonymous surface "/hosgeldin"');
	});

	it("composes the override with the seeded session — one signed-in, flag-on shot", async () => {
		const seen = new Map<string, {cookies: number; forced: Record<string, boolean>}>();
		const {outcome} = await run(happy(), {
			surfaces: ["/hosgeldin:auth"],
			flags: ["welcome-banner=on"],
			env: {
				CLAUDE_PIPELINE_REPO: "o/r",
				PREVIEW_TEST_SESSION_TOKEN: "t".repeat(32),
				BETTER_AUTH_SECRET: "s".repeat(32),
			},
			render: (request) => {
				seen.set(request.surface, {
					cookies: request.cookies.length,
					forced: request.forcedFlags,
				});
				return Effect.succeed(rendered(request.surface, request.outDir));
			},
		});
		expect(outcome.code).toBe(0);
		// Two session cookies (prefixed and bare) plus the one override cookie.
		expect(seen.get("/hosgeldin:auth")).toEqual({
			cookies: 3,
			forced: {"welcome-banner": true},
		});
	});

	it("forces nothing when no --flag is passed, so the default run is untouched", async () => {
		const seen: Array<Record<string, boolean>> = [];
		const {outcome} = await run(happy(), {
			render: (request) => {
				seen.push(request.forcedFlags);
				return Effect.succeed(rendered(request.surface, request.outDir));
			},
		});
		expect(outcome.code).toBe(0);
		expect(seen).toEqual([{}]);
	});

	// A fine PNG of the flag-off page is not a defect in the PR, so it routes UNKNOWN beside a red one.
	it("refuses an inert override on 11, recording no capture", async () => {
		const {outcome, written} = await run(happy(), {
			surfaces: ["/hosgeldin:auth", "/b:auth"],
			flags: ["welcome-banner=on"],
			env: {
				CLAUDE_PIPELINE_REPO: "o/r",
				PREVIEW_TEST_SESSION_TOKEN: "t".repeat(32),
				BETTER_AUTH_SECRET: "s".repeat(32),
			},
			render: legOf({
				"/hosgeldin:auth": {
					_tag: "OverrideInert",
					reason: "the preview evaluated welcome-banner at the default",
				},
				"/b:auth": {_tag: "Crashed", firstError: "TypeError: x is null"},
			}),
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(written.size).toBe(0);
		expect(outcome.stderr.at(-1)).toMatch(/did not render with its forced flags/);
	});

	// The locale operand's own refusals, decided before any read or browser launch, on the same `10`
	// a malformed --flag takes: both would shoot the default page under the requested name.
	const LOCALES: LocaleDeclaration = {storageKey: "app.locale", values: ["tr", "en"]};

	it("refuses --locale when the repo declares no locale, before anything is read", async () => {
		const legCalls: string[] = [];
		const {outcome} = await run([], {
			locale: "en",
			render: (request) => {
				legCalls.push(request.surface);
				return Effect.succeed(rendered(request.surface, request.outDir));
			},
		});
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.join("\n")).toContain('--locale "en" cannot be seeded');
		expect(outcome.stderr.join("\n")).toContain("declares no uiCapture.locale");
		expect(legCalls).toEqual([]);
	});

	it("refuses a --locale value outside the declared list on 10, naming the list", async () => {
		const {outcome} = await run([], {locale: "de", localeDeclaration: LOCALES});
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.join("\n")).toContain("the declared locales are tr, en");
	});

	it("seeds the declared key in every shot, anonymous and tier-naming alike", async () => {
		const seen: unknown[] = [];
		const {outcome} = await run(happy(), {
			surfaces: ["/pano", "/b"],
			viewports: ["desktop", "mobile"],
			locale: "en",
			localeDeclaration: LOCALES,
			render: (request) => {
				seen.push(request.locale);
				return Effect.succeed(
					rendered(request.surface, request.outDir, request.viewport.label, request.viewport.width),
				);
			},
		});
		expect(outcome.code).toBe(0);
		expect(seen).toEqual(Array(4).fill({storageKey: "app.locale", value: "en"}));
		expect(outcome.stderr).toContain(
			'review-ui render: surface "/pano" at desktop in locale en captured: 1280x2140, 0 page error(s)',
		);
	});

	it("seeds nothing without --locale, even when the repo declares one", async () => {
		const seen: unknown[] = [];
		const {outcome} = await run(happy(), {
			localeDeclaration: LOCALES,
			render: (request) => {
				seen.push(request.locale);
				return Effect.succeed(rendered(request.surface, request.outDir));
			},
		});
		expect(outcome.code).toBe(0);
		expect(seen).toEqual([null]);
	});

	it("refuses a shot whose lang did not come back as the seeded locale on 11, recording nothing", async () => {
		const {outcome, written} = await run(happy(), {
			surfaces: ["/pano", "/b"],
			locale: "en",
			localeDeclaration: LOCALES,
			render: legOf({
				"/pano": {_tag: "WrongLocale", wanted: "en", reason: `the page's lang read back "tr"`},
				"/b": {_tag: "Crashed", firstError: "TypeError: x is null"},
			}),
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(written.size).toBe(0);
		expect(outcome.stderr.at(-1)).toBe(
			`review-ui render: surface "/pano" at desktop in locale en did not render in its seeded locale (the page's lang read back "tr") — the seeded locale's render is UNKNOWN, never the default one.`,
		);
	});

	// The scheme operand's refusals are decided before any read or browser launch, on the `10` a
	// malformed --viewport takes: each would shoot the default scheme under the requested name, or
	// overwrite one shot's file with another's.
	const SCHEMES: SchemeDeclaration = {rootAttribute: "data-theme"};

	it("refuses a --scheme outside light and dark on 10, before anything is read", async () => {
		const legCalls: string[] = [];
		const {outcome} = await run([], {
			schemes: ["dim"],
			schemeDeclaration: SCHEMES,
			render: (request) => {
				legCalls.push(request.surface);
				return Effect.succeed(rendered(request.surface, request.outDir));
			},
		});
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.at(-1)).toBe(
			'review-ui render: --scheme "dim" is not a colour scheme this verb renders — the names are light, dark.',
		);
		expect(legCalls).toEqual([]);
	});

	it("refuses a --scheme passed twice on 10", async () => {
		const {outcome} = await run([], {schemes: ["dark", "dark"], schemeDeclaration: SCHEMES});
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.at(-1)).toContain('--scheme "dark" was passed twice');
	});

	it("refuses --scheme when the repo declares no uiCapture.scheme — there is nothing to prove it against", async () => {
		const {outcome} = await run([], {schemes: ["dark"]});
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.at(-1)).toContain('--scheme "dark" cannot be proved');
		expect(outcome.stderr.at(-1)).toContain("declares no uiCapture.scheme");
	});

	it("crosses every requested scheme with every surface and viewport, never substituting the default", async () => {
		const seen: string[] = [];
		const {outcome} = await run(happy(), {
			surfaces: ["/pano", "/b"],
			viewports: ["desktop", "mobile"],
			schemes: ["light", "dark"],
			schemeDeclaration: SCHEMES,
			render: (request) => {
				seen.push(
					`${request.surface} ${request.viewport.label} ${request.scheme?.scheme} ${request.scheme?.rootAttribute}`,
				);
				return Effect.succeed(
					rendered(request.surface, request.outDir, request.viewport.label, request.viewport.width),
				);
			},
		});
		expect(outcome.code).toBe(0);
		expect(seen).toEqual([
			"/pano desktop light data-theme",
			"/pano desktop dark data-theme",
			"/pano mobile light data-theme",
			"/pano mobile dark data-theme",
			"/b desktop light data-theme",
			"/b desktop dark data-theme",
			"/b mobile light data-theme",
			"/b mobile dark data-theme",
		]);
		expect(outcome.stderr).toContain(
			'review-ui render: surface "/pano" at mobile in scheme dark captured: 390x2140, 0 page error(s)',
		);
	});

	it("emulates nothing without --scheme, even when the repo declares one", async () => {
		const seen: unknown[] = [];
		const {outcome} = await run(happy(), {
			schemeDeclaration: SCHEMES,
			render: (request) => {
				seen.push(request.scheme);
				return Effect.succeed(rendered(request.surface, request.outDir));
			},
		});
		expect(outcome.code).toBe(0);
		expect(seen).toEqual([null]);
		expect(outcome.stderr).toContain(
			'review-ui render: surface "/pano" at desktop captured: 1280x2140, 0 page error(s)',
		);
	});

	it("refuses a shot that did not resolve to its requested scheme on 11, recording nothing", async () => {
		const {outcome, written} = await run(happy(), {
			schemes: ["dark"],
			schemeDeclaration: SCHEMES,
			render: () =>
				Effect.succeed({
					_tag: "WrongScheme",
					wanted: "dark",
					reason: `the page's data-theme read back "light"`,
				} satisfies SurfaceRender),
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(written.size).toBe(0);
		expect(outcome.stderr.at(-1)).toBe(
			`review-ui render: surface "/pano" at desktop in scheme dark did not resolve to the dark scheme (the page's data-theme read back "light") — the requested scheme's render is UNKNOWN, never the other one.`,
		);
	});

	it("carries each shot's requested and proven scheme into the manifest it writes", async () => {
		const {outcome, written} = await run(happy(), {
			schemes: ["light", "dark"],
			schemeDeclaration: SCHEMES,
			render: (request) => {
				const scheme = request.scheme?.scheme ?? "light";
				return Effect.succeed({
					_tag: "Rendered",
					entry: {
						surface: request.surface,
						viewport: request.viewport.label,
						scheme: {requested: scheme, proven: scheme},
						path: `${request.outDir}/pano@desktop-${scheme}.png`,
						width: 1280,
						height: 2140,
						sha256: "9c41",
						pageErrors: {rows: [], more: 0},
					},
				} satisfies SurfaceRender);
			},
		});
		expect(outcome.code).toBe(0);
		const manifest = parseManifest(
			written.get("/tmp/fabrika-review-ui/4321-03135b91/judged/manifest.json") ?? "",
		);
		expect(manifest._tag === "Manifest" && manifest.value.captures.map((c) => c.scheme)).toEqual([
			{requested: "light", proven: "light"},
			{requested: "dark", proven: "dark"},
		]);
	});

	// The accent operand's refusals are decided before any read or browser launch, on the same `10`:
	// each would shoot the default accent under the requested name.
	const ACCENTS: AccentDeclaration = {
		rootAttribute: "data-color-theme",
		values: ["ember", "amber"],
	};

	it("refuses --accent when the repo declares no uiCapture.accent on 10, before anything is read", async () => {
		const legCalls: string[] = [];
		const {outcome} = await run([], {
			accent: "amber",
			render: (request) => {
				legCalls.push(request.surface);
				return Effect.succeed(rendered(request.surface, request.outDir));
			},
		});
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.at(-1)).toBe(
			'review-ui render: --accent "amber" cannot be set (this repo declares no uiCapture.accent, so there is no root attribute to set it on) — an operand nothing sets would shoot the default accent under the requested name.',
		);
		expect(legCalls).toEqual([]);
	});

	it("refuses an --accent outside the declared list on 10, naming the list", async () => {
		const {outcome} = await run([], {accent: "jade", accentDeclaration: ACCENTS});
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.at(-1)).toBe(
			'review-ui render: --accent "jade" is not an accent this repo declares — the declared accents are ember, amber.',
		);
	});

	it("sets the accent on every surface, viewport and scheme, never substituting the default", async () => {
		const seen: string[] = [];
		const {outcome} = await run(happy(), {
			surfaces: ["/pano", "/b"],
			viewports: ["desktop", "mobile"],
			schemes: ["light", "dark"],
			schemeDeclaration: SCHEMES,
			accent: "amber",
			accentDeclaration: ACCENTS,
			render: (request) => {
				seen.push(
					`${request.surface} ${request.viewport.label} ${request.scheme?.scheme} ${request.accent?.rootAttribute}=${request.accent?.value}`,
				);
				return Effect.succeed(
					rendered(request.surface, request.outDir, request.viewport.label, request.viewport.width),
				);
			},
		});
		expect(outcome.code).toBe(0);
		expect(seen).toHaveLength(8);
		expect(seen.every((line) => line.endsWith(" data-color-theme=amber"))).toBe(true);
		expect(outcome.stderr).toContain(
			'review-ui render: surface "/b" at mobile in scheme dark in accent amber captured: 390x2140, 0 page error(s)',
		);
	});

	it("sets nothing without --accent and keeps every line as before, even when the repo declares one", async () => {
		const seen: unknown[] = [];
		const {outcome} = await run(happy(), {
			accentDeclaration: ACCENTS,
			render: (request) => {
				seen.push(request.accent);
				return Effect.succeed(rendered(request.surface, request.outDir));
			},
		});
		expect(outcome.code).toBe(0);
		expect(seen).toEqual([null]);
		expect(outcome.stderr).toContain(
			'review-ui render: surface "/pano" at desktop captured: 1280x2140, 0 page error(s)',
		);
		expect(outcome.stdout).not.toContain("accent");
	});

	it("refuses a shot that did not render in its requested accent on 11, recording nothing", async () => {
		const {outcome, written} = await run(happy(), {
			surfaces: ["/pano", "/b"],
			accent: "amber",
			accentDeclaration: ACCENTS,
			render: legOf({
				"/pano": {
					_tag: "WrongAccent",
					wanted: "amber",
					reason: `the page's data-color-theme read back "ember"`,
				},
			}),
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(written.size).toBe(0);
		expect(outcome.stderr.at(-1)).toBe(
			`review-ui render: surface "/pano" at desktop in accent amber did not render in the amber accent (the page's data-color-theme read back "ember") — the requested accent's render is UNKNOWN, never the default one.`,
		);
	});

	it("carries each shot's requested and proven accent into the manifest it writes", async () => {
		const {outcome, written} = await run(happy(), {
			accent: "amber",
			accentDeclaration: ACCENTS,
			render: (request) =>
				Effect.succeed({
					_tag: "Rendered",
					entry: {
						surface: request.surface,
						viewport: request.viewport.label,
						accent: {requested: "amber", proven: "amber"},
						path: `${request.outDir}/pano@desktop.png`,
						width: 1280,
						height: 2140,
						sha256: "9c41",
						pageErrors: {rows: [], more: 0},
					},
				} satisfies SurfaceRender),
		});
		expect(outcome.code).toBe(0);
		const manifest = parseManifest(
			written.get("/tmp/fabrika-review-ui/4321-03135b91/judged/manifest.json") ?? "",
		);
		expect(manifest._tag === "Manifest" && manifest.value.captures.map((c) => c.accent)).toEqual([
			{requested: "amber", proven: "amber"},
		]);
	});

	it("refuses a closed PR on 7 — a closed PR is provably not reviewable scope", async () => {
		const {outcome} = await run([
			[PULL, pull("closed")],
			[COMMENTS, announcement()],
		]);
		expect(outcome.code).toBe(ZERO_SCOPE);
	});

	it("proves CANT-SEE (16) only when no comment carries the preview anchor", async () => {
		const none: HttpReply = {
			status: 200,
			body: JSON.stringify([
				{id: 1, user: {login: "x"}, created_at: "", updated_at: "", body: "looks fine"},
			]),
		};
		const {outcome} = await run([
			[PULL, pull()],
			[COMMENTS, none],
		]);
		expect(outcome.code).toBe(NO_PREVIEW);
	});

	it("calls a malformed announcement UNKNOWN (11), never absent", async () => {
		const malformed: HttpReply = {
			status: 200,
			body: JSON.stringify([
				{
					id: 1,
					user: {login: "x"},
					created_at: "",
					updated_at: "",
					body: "<!-- preview-deploy:web -->\n- **web** — the deploy failed",
				},
			]),
		};
		const {outcome} = await run([
			[PULL, pull()],
			[COMMENTS, malformed],
		]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("refuses a preview that lags the live head on 12 — old pixels never bind a new head", async () => {
		const {outcome} = await run([
			[PULL, pull()],
			[COMMENTS, announcement("0b1c2d3")],
		]);
		expect(outcome.code).toBe(STALE_TREE);
		expect(outcome.stderr.at(-1)).toMatch(/stale preview/);
	});

	it("routes mixed outcomes by the smallest applicable code, enumerating all of them", async () => {
		const {outcome} = await run(happy(), {
			surfaces: ["/a", "/b", "/c"],
			render: legOf({
				"/a": {_tag: "Unreachable", reason: "status 404"},
				"/b": {_tag: "Crashed", firstError: "TypeError: x is null"},
				"/c": {_tag: "Invalid", detail: "zero bytes"},
			}),
		});
		expect(outcome.code).toBe(RENDER_CRASHED);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.some((line) => line.includes("unreachable"))).toBe(true);
		expect(outcome.stderr.some((line) => line.includes("invalid bytes"))).toBe(true);
		// The refusal names a surface the ROUTED code applies to, not merely the first bad one.
		expect(outcome.stderr.at(-1)).toMatch(/surface "\/b" at desktop threw during render/);
	});

	it("seats an unreachable-only set on 14 and an invalid-only set on 15", async () => {
		const unreachable = await run(happy(), {
			render: legOf({"/pano": {_tag: "Unreachable", reason: "status 404"}}),
		});
		expect(unreachable.outcome.code).toBe(SURFACE_UNREACHABLE);
		const invalid = await run(happy(), {
			render: legOf({"/pano": {_tag: "Invalid", detail: "zero bytes"}}),
		});
		expect(invalid.outcome.code).toBe(INVALID_CAPTURE);
	});

	// Omitting the operand is what every invocation written before it did, so the default must stay
	// the single desktop shot rather than becoming a cross-product nobody asked for.
	it("renders at desktop alone when no --viewport is passed", async () => {
		const seen: string[] = [];
		const {outcome} = await run(happy(), {
			surfaces: ["/pano", "/pano/yeni"],
			render: (request) => {
				seen.push(`${request.surface}@${request.viewport.label}`);
				return Effect.succeed(
					rendered(request.surface, request.outDir, request.viewport.label, request.viewport.width),
				);
			},
		});
		expect(outcome.code).toBe(0);
		expect(seen).toEqual(["/pano@desktop", "/pano/yeni@desktop"]);
	});

	it("crosses viewports with surfaces: two of each is four captures under four file names", async () => {
		const {outcome} = await run(happy(), {
			surfaces: ["/pano", "/pano/yeni"],
			viewports: ["desktop", "mobile"],
		});
		expect(outcome.code).toBe(0);
		const read = parseManifest(outcome.stdout);
		expect(read._tag).toBe("Manifest");
		const captures = read._tag === "Manifest" ? read.value.captures : [];
		expect(captures).toHaveLength(4);
		expect(captures.map((entry) => `${entry.surface}@${entry.viewport}`)).toEqual([
			"/pano@desktop",
			"/pano@mobile",
			"/pano/yeni@desktop",
			"/pano/yeni@mobile",
		]);
		expect(new Set(captures.map((entry) => entry.path)).size).toBe(4);
	});

	it("refuses an off-vocabulary --viewport on 10, listing the names it does render", async () => {
		const {outcome} = await run(happy(), {viewports: ["tablet"]});
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.join("\n")).toContain("the names are desktop, mobile");
	});

	it("refuses one --viewport passed twice on 10 — the second shot overwrites the first", async () => {
		const {outcome} = await run(happy(), {viewports: ["mobile", "mobile"]});
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.join("\n")).toContain('--viewport "mobile" was passed twice');
	});

	// A desktop-width shot filed under `mobile` answers the narrow half of the law from the wrong
	// pixels, which no byte check downstream can tell from the real thing.
	it("refuses a shot whose bytes read back at another width on 19, recording no capture", async () => {
		const {outcome, written} = await run(happy(), {
			viewports: ["mobile"],
			render: legOf({"/pano": {_tag: "WrongViewport", wanted: 390, rendered: 1280}}),
		});
		expect(outcome.code).toBe(WRONG_VIEWPORT);
		expect(outcome.stdout).toBe("");
		expect(written.size).toBe(0);
		expect(outcome.stderr.at(-1)).toContain(
			'surface "/pano" at mobile was asked for at 390px and its bytes read back 1280px wide',
		);
	});

	// The bug this fence closes: every surface is shot at the one announced origin, so a foreign
	// surface came back as web's 404 — a valid PNG the outcome typing recorded as `captured`.
	it("refuses a surface whose app the preview does not announce on 11, before any shot", async () => {
		const shot: string[] = [];
		const {outcome, written} = await run(happy(), {
			surfaces: ["/desk/board"],
			render: (request) => {
				shot.push(request.surface);
				return Effect.succeed(rendered(request.surface, "/tmp"));
			},
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(written.size).toBe(0);
		expect(shot).toEqual([]);
		expect(outcome.stderr.at(-1)).toContain(
			'--surface "/desk/board" is served by app "desk" (row "desk-board"), which this preview does not announce — it announces web',
		);
	});

	it("resolves the surface by longest claiming mount, so /lab stays web's and captures", async () => {
		const {outcome} = await run(happy(), {surfaces: ["/lab"]});
		expect(outcome.code).toBe(0);
		expect(parseManifest(outcome.stdout)).toMatchObject({
			value: {captures: [{surface: "/lab"}]},
		});
	});

	it("refuses the whole set rather than capturing the announced half of a mixed one", async () => {
		const shot: string[] = [];
		const {outcome, written} = await run(happy(), {
			surfaces: ["/pano", "/desk/board:auth"],
			render: (request) => {
				shot.push(request.surface);
				return Effect.succeed(rendered(request.surface, "/tmp"));
			},
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(shot).toEqual([]);
		expect(written.size).toBe(0);
		// The tier state rides the surface id, so the fence reads the route half of it and fires on the
		// one foreign surface rather than on the announced one beside it.
		expect(outcome.stderr.at(-1)).toContain('--surface "/desk/board:auth" is served by app "desk"');
	});

	it("fences nothing when the repo declares no surfaces — the list answers for no surface", async () => {
		const {outcome} = await run(happy(), {surfaceRows: []});
		expect(outcome.code).toBe(0);
	});

	it("keeps a render that never became answerable UNKNOWN (11), not a bad render", async () => {
		const {outcome} = await run(happy(), {
			render: legOf({"/pano": {_tag: "Failed", reason: "the browser provision is broken"}}),
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});
});

/**
 * The interaction operand: every refusal is decided before anything is read or launched, every
 * interacted shot rides beside its surface's at-rest one, and a state the page never reached is
 * UNKNOWN with no manifest written.
 */
describe("runRender — the interaction operand", () => {
	const MENU = '/pano#sil-highlighted=click:role=button[name="Aç"];hover:role=menuitem[name="Sil"]';

	it.each([
		["an unknown step verb", "/pano#x=tap:#b", "names no step verb"],
		["an empty locator", "/pano#x=hover:", 'step "hover:" names no locator'],
		["an empty label", "/pano#=hover:#b", "its label is empty"],
		["steps ending on a click", "/pano#x=hover:#a;click:#b", 'end on "click:#b"'],
		["steps ending on a key press", "/pano#x=press:Escape", 'end on "press:Escape"'],
	])("refuses %s on 10 before anything is read", async (_what, operand, reason) => {
		const {outcome} = await run([], {interactions: [operand]});
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.at(-1)).toContain(`--interact "${operand}" is not <surface>#<label>=`);
		expect(outcome.stderr.at(-1)).toContain(reason);
	});

	it("refuses an operand on a surface the run did not ask for on 10", async () => {
		const {outcome} = await run([], {interactions: ["/sozluk#x=hover:#b"]});
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.at(-1)).toBe(
			'review-ui render: --interact "/sozluk#x=hover:#b" names surface "/sozluk", which no --surface asked for — an interaction runs on a surface of this run.',
		);
	});

	it("refuses two operands that would write the same PNG on 10", async () => {
		const {outcome} = await run([], {
			interactions: ["/pano#x=hover:#a", "/pano#x=focus:#b"],
		});
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.at(-1)).toBe(
			'review-ui render: --interact "/pano#x=focus:#b" would write the same PNG as --interact "/pano#x=hover:#a" — the second shot would overwrite the first\'s file and evidence.',
		);
	});

	it("shoots each interaction beside its surface at rest, in order, and names its label on stderr", async () => {
		const seen: Array<string | null> = [];
		const {outcome} = await run(happy(), {
			surfaces: ["/pano", "/b"],
			interactions: [MENU, "/pano#focused=focus:#q"],
			render: (request) => {
				seen.push(`${request.surface} ${request.interaction?.label ?? "rest"}`);
				return Effect.succeed(rendered(request.surface, request.outDir));
			},
		});
		expect(outcome.code).toBe(0);
		expect(seen).toEqual(["/pano rest", "/pano sil-highlighted", "/pano focused", "/b rest"]);
		expect(outcome.stderr).toContain(
			'review-ui render: surface "/pano" at desktop with interaction sil-highlighted captured: 1280x2140, 0 page error(s)',
		);
	});

	it("refuses a state the page never reached on 11, naming the label and writing no manifest", async () => {
		const {outcome, written} = await run(happy(), {
			interactions: [MENU],
			render: (request) =>
				Effect.succeed(
					request.interaction === null
						? rendered(request.surface, request.outDir)
						: ({
								_tag: "Uninteracted",
								reason: `hover:role=menuitem[name="Sil"]: no element matched role=menuitem[name="Sil"] within 5000ms`,
							} satisfies SurfaceRender),
				),
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(written.size).toBe(0);
		expect(outcome.stderr.at(-1)).toBe(
			`review-ui render: surface "/pano" at desktop with interaction sil-highlighted did not reach its interaction state (hover:role=menuitem[name="Sil"]: no element matched role=menuitem[name="Sil"] within 5000ms) — the interacted render is UNKNOWN, never the at-rest one; no capture was written.`,
		);
	});

	it("keeps a crashed shot on 13 — the crash outranks the interaction inside the shot", async () => {
		const {outcome} = await run(happy(), {
			interactions: [MENU],
			render: (request) =>
				Effect.succeed(
					request.interaction === null
						? rendered(request.surface, request.outDir)
						: ({_tag: "Crashed", firstError: "TypeError: x is null"} satisfies SurfaceRender),
				),
		});
		expect(outcome.code).toBe(RENDER_CRASHED);
		expect(outcome.stderr.at(-1)).toContain("with interaction sil-highlighted threw during render");
	});

	it("keeps every name, entry and line of a run with no interaction as it was", async () => {
		const seen: unknown[] = [];
		const {outcome} = await run(happy(), {
			render: (request) => {
				seen.push(request.interaction);
				return Effect.succeed(rendered(request.surface, request.outDir));
			},
		});
		expect(outcome.code).toBe(0);
		expect(seen).toEqual([null]);
		const manifest = parseManifest(outcome.stdout);
		expect(
			manifest._tag === "Manifest" && "interaction" in (manifest.value.captures[0] ?? {}),
		).toBe(false);
		expect(outcome.stderr).toContain(
			'review-ui render: surface "/pano" at desktop captured: 1280x2140, 0 page error(s)',
		);
	});

	/**
	 * Through the real leg, so the file name is the plan's own and not the fake's: a signed-in,
	 * flag-forced, seeded-locale, dark, mobile shot of an open menu.
	 */
	it("composes with :auth, --flag, --locale, --scheme, --accent and --viewport — one pinned name and entry", async () => {
		const pngHeader = (width: number): Uint8Array => {
			const bytes = new Uint8Array(24);
			bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
			bytes.set([0x49, 0x48, 0x44, 0x52], 12);
			new DataView(bytes.buffer).setUint32(16, width);
			new DataView(bytes.buffer).setUint32(20, 2140);
			return bytes;
		};
		const capture: CaptureShots = (plan, outDir) =>
			Effect.succeed(
				plan.map((shot) => ({
					surface: shot.surface.surface,
					route: shot.surface.route,
					state: shot.surface.state,
					fileName: shot.fileName,
					localPath: `${outDir}/${shot.fileName}`,
					pngBytes: pngHeader(shot.viewport.width),
					pageErrors: [],
					status: 200,
					sessionProof: {_tag: "SignedIn", userId: "u1", tier: "yazar"},
					overrideProof: {_tag: "Forced"},
					localeProof: {_tag: "Seeded"},
					accentProof: {_tag: "Proven", accent: "amber"},
					...(shot.scheme === undefined
						? {}
						: {schemeProof: {_tag: "Proven", scheme: shot.scheme.scheme}}),
					...(shot.interaction === undefined
						? {}
						: {
								interactionProof: {
									_tag: "Proven",
									proven: ['role=menuitem[name="Sil"] matches :hover'],
								},
							}),
				})),
			);
		const {outcome} = await run(happy(), {
			surfaces: ["/pano:auth"],
			viewports: ["mobile"],
			flags: ["welcome-banner=on"],
			locale: "en",
			localeDeclaration: {storageKey: "app.locale", values: ["tr", "en"]},
			schemes: ["dark"],
			schemeDeclaration: {rootAttribute: "data-theme"},
			accent: "amber",
			accentDeclaration: {rootAttribute: "data-color-theme", values: ["ember", "amber"]},
			interactions: [
				'/pano:auth#sil-highlighted=click:role=button[name="Aç"];hover:role=menuitem[name="Sil"]',
			],
			env: {
				CLAUDE_PIPELINE_REPO: "o/r",
				PREVIEW_TEST_SESSION_TOKEN: "t".repeat(32),
				BETTER_AUTH_SECRET: "s".repeat(32),
			},
			render: makeCaptureRenderLeg(capture),
		});
		expect(outcome.code).toBe(0);
		const manifest = parseManifest(outcome.stdout);
		expect(manifest._tag === "Manifest" && manifest.value.captures[1]).toEqual({
			surface: "/pano:auth",
			viewport: "mobile",
			scheme: {requested: "dark", proven: "dark"},
			accent: {requested: "amber", proven: "amber"},
			interaction: {
				label: "sil-highlighted",
				steps: ['click:role=button[name="Aç"]', 'hover:role=menuitem[name="Sil"]'],
				proven: ['role=menuitem[name="Sil"] matches :hover'],
			},
			path: "/tmp/fabrika-review-ui/4321-03135b91/judged/pano-auth~sil-highlighted@mobile-dark.png",
			width: 390,
			height: 2140,
			sha256: expect.any(String),
			pageErrors: {rows: [], more: 0},
		});
		expect(outcome.stderr).toContain(
			'review-ui render: surface "/pano:auth" at mobile in locale en in scheme dark in accent amber with interaction sil-highlighted captured: 390x2140, 0 page error(s)',
		);
	});
});
