/**
 * The fence between the committed public preview key and every non-preview stage (ADR 0406).
 *
 * The file read below is load-bearing, not decoration: the refusal keys on a prefix, so a rotation
 * that dropped the prefix would leave `judgeAuthSecret` accepting the committed key everywhere
 * while every test here still passed. Reading the real file is what makes that drift impossible.
 */
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {ENVIRONMENTS, type Environment} from "./environment.ts";
import {
	assertAuthSecretForEnvironment,
	isPreviewAuthKey,
	judgeAuthSecret,
	PREVIEW_AUTH_KEY_PATH,
	PREVIEW_AUTH_KEY_PREFIX,
	PreviewAuthKeyOffPreviewError,
} from "./preview-auth-key.ts";

// `apps/web/worker` → the repo root is three levels up.
const repoRoot = join(import.meta.dirname, "..", "..", "..");
const committedKey = readFileSync(join(repoRoot, PREVIEW_AUTH_KEY_PATH), "utf8").trim();

describe("the committed preview key", () => {
	it("wears the prefix the fence keys on", () => {
		expect(committedKey.startsWith(PREVIEW_AUTH_KEY_PREFIX)).toBe(true);
	});

	it("is long enough that better-auth's own entropy floor stays quiet", () => {
		expect(committedKey.length).toBeGreaterThanOrEqual(32);
	});
});

describe("judgeAuthSecret (which stage may verify with which key)", () => {
	it("accepts the committed key on a preview stage — the whole point of committing it", () => {
		expect(judgeAuthSecret("preview", committedKey)).toEqual({_tag: "Accepted"});
	});

	it("refuses the committed key on every environment that is not preview", () => {
		for (const environment of ENVIRONMENTS.filter((e) => e !== "preview")) {
			expect(judgeAuthSecret(environment, committedKey)).toEqual({
				_tag: "PreviewKeyOffPreview",
				environment,
			});
		}
	});

	it("refuses any future preview-prefixed key, not only the one committed today", () => {
		expect(judgeAuthSecret("production", `${PREVIEW_AUTH_KEY_PREFIX}rotated-tomorrow`)).toEqual({
			_tag: "PreviewKeyOffPreview",
			environment: "production",
		});
	});

	it("tolerates the trailing newline a file export carries", () => {
		expect(judgeAuthSecret("production", `${committedKey}\n`)._tag).toBe("PreviewKeyOffPreview");
	});

	it("accepts a founder-held secret on every environment", () => {
		for (const environment of ENVIRONMENTS) {
			expect(judgeAuthSecret(environment, "a1b2c3-not-a-preview-key")).toEqual({
				_tag: "Accepted",
			});
		}
	});
});

describe("isPreviewAuthKey", () => {
	it("reads the prefix, and reads nothing else", () => {
		expect(isPreviewAuthKey(committedKey)).toBe(true);
		expect(isPreviewAuthKey("insecure_f0fe1c42")).toBe(false);
		expect(isPreviewAuthKey("")).toBe(false);
		expect(isPreviewAuthKey(`not-a-${PREVIEW_AUTH_KEY_PREFIX}key`)).toBe(false);
	});
});

describe("assertAuthSecretForEnvironment (the boot refusal better-auth-live.ts calls)", () => {
	it("throws on production, naming the environment and the committed path", () => {
		let thrown: unknown;
		try {
			assertAuthSecretForEnvironment("production", committedKey);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(PreviewAuthKeyOffPreviewError);
		expect((thrown as PreviewAuthKeyOffPreviewError).environment).toBe("production");
		expect((thrown as Error).message).toContain(PREVIEW_AUTH_KEY_PATH);
	});

	it("returns quietly on a preview stage", () => {
		expect(() =>
			assertAuthSecretForEnvironment("preview" satisfies Environment, committedKey),
		).not.toThrow();
	});
});
