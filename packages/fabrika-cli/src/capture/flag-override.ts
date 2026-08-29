/**
 * Force a flag for a capture, so a dark-shipped surface paints the state the PR actually adds
 * (#7218, ADR 0336). Pure — no browser, no network; `capture.ts` seeds the cookie this builds and
 * hands the probe's raw answer back to {@link readOverrideProof}.
 *
 * The mechanism is the worker's existing `phoenix_flag_overrides` cookie and nothing new. The wire
 * value is `encodeURIComponent(JSON.stringify({key: boolean}))`, which is exactly what
 * `apps/web/worker/features/flagship/dev-override.ts`'s `parseOverrideCookie` reads back, and the
 * gate that decides whether to honor it (`override-authz.ts`) is untouched: on a deployed stage it
 * answers `true` only for a request whose actor holds platform `Admin`. So a forced capture is an
 * authorized admin's capture or it is nothing.
 *
 * "Or it is nothing" is why the proof exists. A dropped cookie renders the flag-off page cleanly,
 * which is a valid PNG under the flag-on name — the #7051 class one layer over, and no byte check
 * can tell the two apart.
 */
import type {CaptureCookie} from "./capture.ts";

export const FLAG_OVERRIDE_COOKIE = "phoenix_flag_overrides";

/** The flags a capture forces, and the value each is forced to. */
export type ForcedFlags = Readonly<Record<string, boolean>>;

export const NO_FORCED_FLAGS: ForcedFlags = {};

export const isForcing = (flags: ForcedFlags): boolean => Object.keys(flags).length > 0;

/** The closed value vocabulary. `true`/`1`/`yes` are refused rather than guessed at. */
export const FORCED_VALUES = ["on", "off"] as const;

/**
 * Two arms, never a tolerant one: an operand this cannot read is refused before a browser launches,
 * because the alternative is a run that renders the default state under the forced name.
 */
export type FlagOperandRead =
	| {readonly _tag: "Forced"; readonly flags: ForcedFlags}
	| {readonly _tag: "Malformed"; readonly token: string; readonly reason: string};

/**
 * Bounded before the shape test so the linear scan below stays linear on any input, the same
 * clamp-then-match discipline `plan.ts`'s file-name sanitizer states (CodeQL alert #24).
 */
const MAX_KEY_LENGTH = 128;

/** A single greedy quantifier over a negated-free class — linear, no backtracking. */
const KEY_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const parseFlagOperands = (tokens: readonly string[]): FlagOperandRead => {
	const flags: Record<string, boolean> = {};
	for (const token of tokens) {
		const equals = token.indexOf("=");
		if (equals === -1) {
			return {_tag: "Malformed", token, reason: "no = separating the key from its value"};
		}
		const key = token.slice(0, equals);
		const value = token.slice(equals + 1);
		if (key.length > MAX_KEY_LENGTH) {
			return {_tag: "Malformed", token, reason: `the key exceeds ${MAX_KEY_LENGTH} characters`};
		}
		if (!KEY_SHAPE.test(key)) {
			return {_tag: "Malformed", token, reason: `"${key}" is not a flag key`};
		}
		if (value !== "on" && value !== "off") {
			return {
				_tag: "Malformed",
				token,
				reason: `"${value}" is not ${FORCED_VALUES.join(" or ")}`,
			};
		}
		// Last-wins would resolve two operands for one key into a state the caller never asked for,
		// and the losing one would never be reported.
		if (Object.hasOwn(flags, key)) {
			return {_tag: "Malformed", token, reason: `"${key}" is forced more than once`};
		}
		flags[key] = value === "on";
	}
	return {_tag: "Forced", flags};
};

/**
 * The override cookie for a preview base URL, or nothing when no flag is forced.
 *
 * It carries no `expires` and no `max-age`, so it is a session cookie in the throwaway browser
 * context `capture.ts` opens and closes around each shot: the override's whole lifetime is that
 * context's, and the server records none of it — the cookie is read per request and never stored.
 */
export const overrideCookies = (
	previewUrl: string,
	flags: ForcedFlags,
): readonly CaptureCookie[] => {
	if (!isForcing(flags)) return [];
	return [
		{
			name: FLAG_OVERRIDE_COOKIE,
			value: encodeURIComponent(JSON.stringify(flags)),
			url: previewUrl,
			secure: new URL(previewUrl).protocol === "https:",
		},
	];
};

/**
 * The preview endpoint that answers what a flag evaluated to for THIS context — the same seam the
 * SPA reads through, so its answer is the one the pixels were painted from
 * (`apps/web/worker/features/flagship/route.ts`, ADR 0179 AC2).
 */
export const FLAG_PROBE_PATH = "/api/flags/evaluate";

/**
 * The probe body: every forced key asked for with the **opposite** value as its default. The route
 * resolves a key it cannot evaluate to the default it was asked with
 * (`flagship/evaluate-contract.ts`), so a dropped cookie answers `!forced` for every key and the
 * inertness is decidable from the body rather than inferred from a picture.
 */
export const flagProbeBody = (flags: ForcedFlags): string =>
	JSON.stringify({
		keys: Object.entries(flags).map(([key, forced]) => ({key, default: !forced})),
	});

/**
 * Whether the forced flags actually took, decided from the preview's own answer.
 *
 * Three arms, not two: a probe that could not be read is UNKNOWN and must not collapse into
 * "the override was dropped" — both refuse, but only one is a fact about the override.
 */
export type OverrideProof =
	| {readonly _tag: "Forced"}
	| {readonly _tag: "Inert"; readonly keys: readonly string[]}
	| {readonly _tag: "Unreadable"; readonly reason: string};

export const readOverrideProof = (
	status: number,
	body: string,
	flags: ForcedFlags,
): OverrideProof => {
	if (status !== 200) return {_tag: "Unreadable", reason: `probe answered ${status}`};
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return {_tag: "Unreadable", reason: "probe body is not JSON"};
	}
	if (typeof parsed !== "object" || parsed === null) {
		return {_tag: "Unreadable", reason: "probe body is not an evaluation object"};
	}
	const evaluated = (parsed as {flags?: unknown}).flags;
	if (typeof evaluated !== "object" || evaluated === null) {
		return {_tag: "Unreadable", reason: "probe body names no flags"};
	}
	const answers = evaluated as Record<string, unknown>;
	const inert: string[] = [];
	for (const [key, forced] of Object.entries(flags)) {
		const value = answers[key];
		if (typeof value !== "boolean") {
			return {_tag: "Unreadable", reason: `probe left "${key}" unevaluated`};
		}
		if (value !== forced) inert.push(key);
	}
	return inert.length === 0 ? {_tag: "Forced"} : {_tag: "Inert", keys: inert};
};
