import {assert, describe, it} from "@effect/vitest";
import {Effect, Redacted} from "effect";
import {
	describeFailure,
	IDENTITY_TOKEN_ENV,
	type LoginStore,
	mintLoginBundle,
	parseLoginBundle,
	resolveCredentials,
	rotateLogins,
	type StoreWrite,
} from "./logins.ts";
import {MIN_SESSION_TOKEN_LEN, PREVIEW_IDENTITIES} from "./test-account.ts";

// Dummy values throughout: nothing here is, or is derived from, a real login.
const YAZAR = "y".repeat(MIN_SESSION_TOKEN_LEN);
const CAYLAK = "c".repeat(MIN_SESSION_TOKEN_LEN);
const UNVERIFIED = "u".repeat(MIN_SESSION_TOKEN_LEN);

const bundle = (entries: Record<string, unknown>) => Redacted.make(JSON.stringify(entries));

const FULL = bundle({
	[IDENTITY_TOKEN_ENV.yazar]: YAZAR,
	[IDENTITY_TOKEN_ENV.çaylak]: CAYLAK,
	[IDENTITY_TOKEN_ENV["çaylak-unverified"]]: UNVERIFIED,
});

describe("parseLoginBundle", () => {
	it("reads one token per identity, each still redacted", () => {
		const read = parseLoginBundle(FULL);
		assert.strictEqual(read._tag, "Parsed");
		if (read._tag !== "Parsed") return;
		assert.deepStrictEqual(Object.keys(read.tokens), [...PREVIEW_IDENTITIES]);
		assert.strictEqual(Redacted.value(read.tokens.çaylak as Redacted.Redacted<string>), CAYLAK);
		assert.notInclude(JSON.stringify(read), CAYLAK);
	});

	it("refuses text that is not JSON without quoting it", () => {
		// Node's own JSON.parse message quotes the input it failed on, which here is a login.
		const read = parseLoginBundle(Redacted.make(`${YAZAR} not json`));
		assert.deepStrictEqual(read, {_tag: "Malformed", reason: "it is not JSON"});
	});

	it("refuses a JSON value that is not an object", () => {
		assert.strictEqual(parseLoginBundle(Redacted.make(`["${YAZAR}"]`))._tag, "Malformed");
		assert.strictEqual(parseLoginBundle(Redacted.make(`"${YAZAR}"`))._tag, "Malformed");
	});

	it("refuses an unknown key without quoting the key", () => {
		// A botched hand edit can put a token where a key belongs.
		const read = parseLoginBundle(bundle({[YAZAR]: "x"}));
		assert.strictEqual(read._tag, "Malformed");
		assert.notInclude(JSON.stringify(read), YAZAR);
	});

	it("refuses a non-string token", () => {
		const read = parseLoginBundle(bundle({[IDENTITY_TOKEN_ENV.yazar]: 7}));
		assert.strictEqual(read._tag, "Malformed");
	});
});

describe("resolveCredentials", () => {
	const values = (read: ReturnType<typeof resolveCredentials>) =>
		read._tag === "Resolved"
			? Object.fromEntries(
					Object.entries(read.credentials).map(([identity, token]) => [
						identity,
						Redacted.value(token),
					]),
				)
			: read;

	it("takes every identity from the bundle when no own variable is set", () => {
		assert.deepStrictEqual(values(resolveCredentials({}, FULL)), {
			yazar: YAZAR,
			çaylak: CAYLAK,
			"çaylak-unverified": UNVERIFIED,
		});
	});

	it("lets an identity's own variable win over its bundle entry", () => {
		const own = "o".repeat(MIN_SESSION_TOKEN_LEN);
		const read = values(resolveCredentials({çaylak: Redacted.make(own)}, FULL));
		assert.deepStrictEqual(read, {yazar: YAZAR, çaylak: own, "çaylak-unverified": UNVERIFIED});
	});

	it("leaves out an identity neither source names", () => {
		const read = resolveCredentials({}, bundle({[IDENTITY_TOKEN_ENV.yazar]: YAZAR}));
		assert.deepStrictEqual(values(read), {yazar: YAZAR});
	});

	it("resolves nothing when neither source is set", () => {
		assert.deepStrictEqual(resolveCredentials({}, null), {_tag: "Resolved", credentials: {}});
	});

	it("names where a weak token was read, never the token", () => {
		const fromBundle = resolveCredentials({}, bundle({[IDENTITY_TOKEN_ENV.yazar]: "short"}));
		assert.deepStrictEqual(fromBundle, {
			_tag: "Weak",
			source: "$PREVIEW_TEST_LOGINS's PREVIEW_TEST_SESSION_TOKEN",
		});
		const fromOwn = resolveCredentials({çaylak: Redacted.make("short")}, null);
		assert.deepStrictEqual(fromOwn, {_tag: "Weak", source: "$PREVIEW_TEST_CAYLAK_SESSION_TOKEN"});
	});

	it("refuses a malformed bundle even when every identity has its own variable", () => {
		const own = Object.fromEntries(
			PREVIEW_IDENTITIES.map((identity) => [identity, Redacted.make(YAZAR)]),
		);
		assert.strictEqual(resolveCredentials(own, Redacted.make("{"))._tag, "MalformedBundle");
	});
});

describe("describeFailure", () => {
	it("scrubs a token out of every message in the cause chain", () => {
		// The shape a database driver reports a failed statement in: the bound parameters ride along.
		const failure = new Error(`Failed query: insert into "session"\nparams: s1,${YAZAR}`, {
			cause: new Error(`D1 refused ${CAYLAK}`),
		});
		const said = describeFailure(failure, [Redacted.make(YAZAR), Redacted.make(CAYLAK)]);
		assert.notInclude(said, YAZAR);
		assert.notInclude(said, CAYLAK);
		assert.include(said, 'insert into "session"');
		assert.include(said, "caused by: D1 refused <redacted>");
	});

	it("describes a non-Error cause", () => {
		assert.strictEqual(describeFailure("boom", []), "boom");
	});
});

describe("mintLoginBundle", () => {
	it("mints a bundle every identity resolves a distinct strong token from", () => {
		const read = resolveCredentials({}, mintLoginBundle());
		assert.strictEqual(read._tag, "Resolved");
		if (read._tag !== "Resolved") return;
		const minted = Object.values(read.credentials).map(Redacted.value);
		assert.strictEqual(minted.length, PREVIEW_IDENTITIES.length);
		assert.strictEqual(new Set(minted).size, PREVIEW_IDENTITIES.length);
	});
});

describe("rotateLogins", () => {
	const recorder = (refuse: LoginStore | null) => {
		const writes: {store: LoginStore; value: string}[] = [];
		const write = (store: LoginStore, value: Redacted.Redacted<string>) =>
			Effect.sync((): StoreWrite => {
				writes.push({store, value: Redacted.value(value)});
				// A tool that echoes what it was handed, to prove the refusal is scrubbed.
				return store === refuse
					? {_tag: "Refused", reason: `HTTP 403 for ${Redacted.value(value)}`}
					: {_tag: "Written"};
			});
		return {writes, write};
	};

	it.effect("writes the same value to the secret, then to the variable", () =>
		Effect.gen(function* () {
			const {writes, write} = recorder(null);
			const outcome = yield* rotateLogins(write, () => FULL);
			assert.deepStrictEqual(outcome, {_tag: "Rotated", identities: PREVIEW_IDENTITIES});
			assert.deepStrictEqual(
				writes.map(({store}) => store),
				["secret", "variable"],
			);
			assert.strictEqual(writes[0]?.value, writes[1]?.value);
			assert.notInclude(JSON.stringify(outcome), YAZAR);
		}),
	);

	it.effect("stops before the variable when the secret is refused, and scrubs the reason", () =>
		Effect.gen(function* () {
			const {writes, write} = recorder("secret");
			const outcome = yield* rotateLogins(write, () => FULL);
			assert.deepStrictEqual(outcome, {_tag: "SecretRefused", reason: "HTTP 403 for <redacted>"});
			assert.strictEqual(writes.length, 1);
		}),
	);

	it.effect("says the two stores disagree when only the variable is refused", () =>
		Effect.gen(function* () {
			const {writes, write} = recorder("variable");
			const outcome = yield* rotateLogins(write, () => FULL);
			assert.deepStrictEqual(outcome, {
				_tag: "VariableRefused",
				reason: "HTTP 403 for <redacted>",
			});
			assert.strictEqual(writes.length, 2);
		}),
	);
});
