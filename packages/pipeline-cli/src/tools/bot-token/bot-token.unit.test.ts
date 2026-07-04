import {generateKeyPairSync, verify} from "node:crypto";
import {assert, describe, it} from "@effect/vitest";
import {
	buildAppJwt,
	DEFAULT_KEY_PATH,
	expandHome,
	type FetchLike,
	MintError,
	mintInstallationToken,
	resolveIds,
	resolveKeySource,
} from "./bot-token.ts";

// A throwaway RSA keypair generated in-test — proves the signing is correct without a
// live GitHub App. `sign(pem, "base64url")` needs a PKCS#8/PKCS#1 PEM; `pkcs8` is fine.
const {privateKey, publicKey} = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: {type: "spki", format: "pem"},
	privateKeyEncoding: {type: "pkcs8", format: "pem"},
});

const decodeSegment = (seg: string): unknown =>
	JSON.parse(Buffer.from(seg, "base64url").toString("utf8"));

describe("buildAppJwt — RS256 App JWT construction", () => {
	const now = 1_700_000_000;
	const appId = "123456";
	const jwt = buildAppJwt({appId, privateKeyPem: privateKey, nowSeconds: now});

	it("produces a 3-segment JWT", () => {
		assert.strictEqual(jwt.split(".").length, 3);
	});

	it("has header {alg:'RS256',typ:'JWT'}", () => {
		const header = decodeSegment(jwt.split(".")[0] as string);
		assert.deepStrictEqual(header, {alg: "RS256", typ: "JWT"});
	});

	it("payload has iss==appId and a ~600s iat→exp window (back-dated 60s)", () => {
		const payload = decodeSegment(jwt.split(".")[1] as string) as {
			iss: string;
			iat: number;
			exp: number;
		};
		assert.strictEqual(payload.iss, appId);
		assert.strictEqual(payload.iat, now - 60);
		assert.strictEqual(payload.exp, now + 540);
		assert.strictEqual(payload.exp - payload.iat, 600);
	});

	it("signature VERIFIES against the test public key over the signing input", () => {
		const [h, p, sig] = jwt.split(".");
		const signingInput = Buffer.from(`${h}.${p}`, "utf8");
		const ok = verify(
			"RSA-SHA256",
			signingInput,
			publicKey,
			Buffer.from(sig as string, "base64url"),
		);
		assert.isTrue(ok);
	});

	it("a tampered payload fails verification (signature is bound to the exact input)", () => {
		const [h, , sig] = jwt.split(".");
		const forgedPayload = Buffer.from(
			JSON.stringify({iss: "999", iat: 0, exp: 600}),
			"utf8",
		).toString("base64url");
		const signingInput = Buffer.from(`${h}.${forgedPayload}`, "utf8");
		const ok = verify(
			"RSA-SHA256",
			signingInput,
			publicKey,
			Buffer.from(sig as string, "base64url"),
		);
		assert.isFalse(ok);
	});
});

describe("resolveKeySource — inline/path resolution + default-path fallback", () => {
	it("inline only → Inline with the PEM content", () => {
		const r = resolveKeySource({privateKey: "PEM-CONTENT"});
		assert.deepStrictEqual(r, {_tag: "Inline", pem: "PEM-CONTENT"});
	});

	it("path only → File with the path", () => {
		const r = resolveKeySource({privateKeyPath: "/path/to/key.pem"});
		assert.deepStrictEqual(r, {_tag: "File", path: "/path/to/key.pem"});
	});

	it("neither → File at the well-known default local path (local-path shape)", () => {
		const r = resolveKeySource({});
		assert.deepStrictEqual(r, {_tag: "File", path: DEFAULT_KEY_PATH});
	});

	it("both inline AND path → Error", () => {
		const r = resolveKeySource({privateKey: "PEM", privateKeyPath: "/x.pem"});
		assert.strictEqual(r._tag, "Error");
	});

	it("empty strings count as absent → default path", () => {
		const r = resolveKeySource({privateKey: "", privateKeyPath: ""});
		assert.deepStrictEqual(r, {_tag: "File", path: DEFAULT_KEY_PATH});
	});
});

describe("expandHome — leading ~ / $HOME expansion", () => {
	it("expands a leading ~/", () => {
		assert.strictEqual(
			expandHome("~/.config/phoenix-bot/x", "/home/u"),
			"/home/u/.config/phoenix-bot/x",
		);
	});
	it("expands a bare ~", () => {
		assert.strictEqual(expandHome("~", "/home/u"), "/home/u");
	});
	it("expands a leading $HOME/", () => {
		assert.strictEqual(expandHome("$HOME/x", "/home/u"), "/home/u/x");
	});
	it("leaves an absolute path untouched", () => {
		assert.strictEqual(expandHome("/etc/key.pem", "/home/u"), "/etc/key.pem");
	});
	it("does not expand a mid-path ~", () => {
		assert.strictEqual(expandHome("/a/~/b", "/home/u"), "/a/~/b");
	});
});

describe("resolveIds — flag/env > config-file precedence", () => {
	it("flag/env wins over config file", () => {
		const r = resolveIds({
			appId: "AAA",
			installationId: "III",
			configFile: {appId: "cfg-app", installationId: "cfg-inst"},
		});
		assert.deepStrictEqual(r, {_tag: "Ok", appId: "AAA", installationId: "III"});
	});

	it("falls back to config file when flag/env absent", () => {
		const r = resolveIds({configFile: {appId: "cfg-app", installationId: "cfg-inst"}});
		assert.deepStrictEqual(r, {_tag: "Ok", appId: "cfg-app", installationId: "cfg-inst"});
	});

	it("mixes: appId from flag, installationId from config", () => {
		const r = resolveIds({appId: "AAA", configFile: {installationId: "cfg-inst"}});
		assert.deepStrictEqual(r, {_tag: "Ok", appId: "AAA", installationId: "cfg-inst"});
	});

	it("missing appId → Error", () => {
		const r = resolveIds({installationId: "III"});
		assert.strictEqual(r._tag, "Error");
	});

	it("missing installationId → Error", () => {
		const r = resolveIds({appId: "AAA"});
		assert.strictEqual(r._tag, "Error");
	});

	it("empty config + no flags → Error", () => {
		const r = resolveIds({configFile: {}});
		assert.strictEqual(r._tag, "Error");
	});
});

describe("mintInstallationToken — request shape + response handling (fake fetch)", () => {
	const base = {
		appId: "123456",
		installationId: "789",
		privateKeyPem: privateKey,
		nowSeconds: 1_700_000_000,
	};

	it("POSTs the installation access-token endpoint with a Bearer JWT and the required headers", async () => {
		let capturedUrl = "";
		let capturedInit: {method: string; headers: Record<string, string>} | null = null;
		const fakeFetch: FetchLike = async (url, init) => {
			capturedUrl = url;
			capturedInit = init;
			return {ok: true, status: 201, text: async () => JSON.stringify({token: "ghs_faketoken123"})};
		};

		const token = await mintInstallationToken({...base, fetch: fakeFetch});

		assert.strictEqual(token, "ghs_faketoken123");
		assert.strictEqual(capturedUrl, "https://api.github.com/app/installations/789/access_tokens");
		assert.isNotNull(capturedInit);
		const init = capturedInit as {method: string; headers: Record<string, string>};
		assert.strictEqual(init.method, "POST");
		assert.match(init.headers.Authorization ?? "", /^Bearer eyJ|^Bearer [A-Za-z0-9_-]+\./);
		assert.strictEqual(init.headers.Accept, "application/vnd.github+json");
		assert.strictEqual(init.headers["X-GitHub-Api-Version"], "2022-11-28");
		assert.isString(init.headers["User-Agent"]);
	});

	it("the Bearer value is a valid 3-segment JWT signed with the App key", async () => {
		let auth = "";
		const fakeFetch: FetchLike = async (_url, init) => {
			auth = init.headers.Authorization ?? "";
			return {ok: true, status: 201, text: async () => JSON.stringify({token: "ghs_x"})};
		};
		await mintInstallationToken({...base, fetch: fakeFetch});
		const jwt = auth.replace(/^Bearer /, "");
		assert.strictEqual(jwt.split(".").length, 3);
		const [h, p, sig] = jwt.split(".");
		const ok = verify(
			"RSA-SHA256",
			Buffer.from(`${h}.${p}`, "utf8"),
			publicKey,
			Buffer.from(sig as string, "base64url"),
		);
		assert.isTrue(ok);
	});

	it("a non-2xx fails with MintError carrying ONLY status + api .message (no token/pem material)", async () => {
		const fakeFetch: FetchLike = async () => ({
			ok: false,
			status: 404,
			text: async () => JSON.stringify({message: "Not Found"}),
		});
		try {
			await mintInstallationToken({...base, fetch: fakeFetch});
			assert.fail("expected MintError");
		} catch (e) {
			assert.instanceOf(e, MintError);
			const err = e as MintError;
			assert.strictEqual(err.status, 404);
			assert.match(err.message, /404/);
			assert.match(err.message, /Not Found/);
			// no credential material leaks into the error
			assert.notMatch(err.message, /BEGIN|PRIVATE KEY|ghs_|Bearer/);
		}
	});

	it("a 2xx with an empty/missing token is a MintError, not a blank success", async () => {
		const fakeFetch: FetchLike = async () => ({
			ok: true,
			status: 201,
			text: async () => JSON.stringify({token: ""}),
		});
		try {
			await mintInstallationToken({...base, fetch: fakeFetch});
			assert.fail("expected MintError");
		} catch (e) {
			assert.instanceOf(e, MintError);
		}
	});
});
