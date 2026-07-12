/**
 * DOM-free codec + render logic for the flags console module (#2742, epic #2711) — the
 * per-browser flag-override surface. Pure so every decision (parse, apply, serialize, label)
 * is unit-tested without a `document` (the `ban-controls.ts` idiom); `FlagsPanel.tsx` is the
 * thin shell that reads/writes `document.cookie`.
 *
 * The whole point (#2742): a toggle flips a flag ONLY in the admin's own browser by writing the
 * `phoenix_flag_overrides` cookie — never Flagship, never another request. The worker's un-gated
 * #622 read-wrapper (#2741) honors the cookie natively on the next request, so `useFlag` reflects
 * the flip with no client interception.
 *
 * The cookie wire shape mirrors the worker's #622 codec
 * (`worker/features/flagship/dev-override.ts`): a `phoenix_flag_overrides` cookie carrying
 * `encodeURIComponent(JSON.stringify({[key]: boolean}))`. That worker module can't be imported
 * here (it pulls the alchemy `resources.ts` into the SPA bundle), so the codec is re-stated
 * against the SAME contract — a value written here is read back by the worker's `parseOverrideCookie`
 * verbatim. Keep the two in lockstep.
 */

/** The cookie the override map travels in — mirrors `dev-override.ts` `FLAG_OVERRIDE_COOKIE` (#622). */
export const FLAG_OVERRIDE_COOKIE = "phoenix_flag_overrides";

/** The override map: a declared flag key forced to a local boolean value. */
export type FlagOverrides = Readonly<Record<string, boolean>>;

/** No overrides — no cookie, or a malformed one. */
export const emptyOverrides: FlagOverrides = {};

/** A flag's tri-state on the panel: forced on, forced off, or no local override (default holds). */
export type OverrideState = "on" | "off" | "clear";

/** The override an admin's toggle carries: force a key on/off, or clear it back to the default. */
export interface OverrideAction {
	readonly key: string;
	readonly state: OverrideState;
}

/**
 * Apply one tri-state action to an override map: `on`/`off` set the key, `clear` removes it. Pure
 * — the returned map is what {@link encodeOverrideCookieValue} re-serializes into the cookie.
 */
export function applyOverride(
	overrides: FlagOverrides,
	{key, state}: OverrideAction,
): FlagOverrides {
	if (state === "clear") {
		const {[key]: _dropped, ...rest} = overrides;
		return rest;
	}
	return {...overrides, [key]: state === "on"};
}

/** A flag's current override tri-state: present-true ⇒ on, present-false ⇒ off, absent ⇒ clear. */
export function overrideStateOf(overrides: FlagOverrides, key: string): OverrideState {
	if (!(key in overrides)) return "clear";
	return overrides[key] ? "on" : "off";
}

/**
 * The value a flag reads AS in this browser: the local override if one is set, else the declared
 * default. This is what the worker returns natively once it honors the cookie (#2741).
 */
export function effectiveValue(
	defaultValue: boolean,
	overrides: FlagOverrides,
	key: string,
): boolean {
	const override = overrides[key];
	return override === undefined ? defaultValue : override;
}

/**
 * Parse the `phoenix_flag_overrides` map out of a `document.cookie` string (`a=b; c=d`) — the same
 * `name=value` shape as a `Cookie` header, so this mirrors the worker's `parseOverrideCookie`.
 * Untrusted input: an absent cookie, or anything that isn't a well-formed `{[key]: boolean}` JSON
 * object, yields `{}` — a malformed cookie degrades to "no override" rather than throwing.
 */
export function parseOverridesFromCookie(documentCookie: string | null | undefined): FlagOverrides {
	if (!documentCookie) return emptyOverrides;
	const raw = readCookieValue(documentCookie, FLAG_OVERRIDE_COOKIE);
	if (raw === undefined) return emptyOverrides;
	let parsed: unknown;
	try {
		parsed = JSON.parse(decodeURIComponent(raw));
	} catch {
		return emptyOverrides;
	}
	if (typeof parsed !== "object" || parsed === null) return emptyOverrides;
	const out: Record<string, boolean> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (typeof value === "boolean") out[key] = value;
	}
	return out;
}

/** Pull one cookie's raw value out of a `name=value; name2=value2` string. */
function readCookieValue(documentCookie: string, name: string): string | undefined {
	for (const part of documentCookie.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
	}
	return undefined;
}

/** Serialize an override map to the cookie's URL-encoded JSON value (mirrors the worker codec). */
export function encodeOverrideCookieValue(overrides: FlagOverrides): string {
	return encodeURIComponent(JSON.stringify(overrides));
}

/**
 * The full `document.cookie` assignment string for an override map. `path=/` so the worker sees it
 * on every request; `SameSite=Lax` since it rides same-origin reads. An EMPTY map writes a
 * `max-age=0` deletion so clearing the last override removes the cookie entirely rather than
 * leaving a `{}` husk. NOT `Secure` — it must be writable/readable under local `alchemy dev` (http).
 */
export function serializeOverrideCookie(overrides: FlagOverrides): string {
	const attrs = "path=/; SameSite=Lax";
	if (Object.keys(overrides).length === 0) {
		return `${FLAG_OVERRIDE_COOKIE}=; ${attrs}; max-age=0`;
	}
	// One year — a local override is a deliberate dev/admin choice, not a session artifact.
	return `${FLAG_OVERRIDE_COOKIE}=${encodeOverrideCookieValue(overrides)}; ${attrs}; max-age=31536000`;
}

/** A boolean rendered as lowercase-Turkish on/off. */
export const booleanLabel = (value: boolean): string => (value ? "açık" : "kapalı");

/** The declared-default line for a flag row. */
export const defaultLabel = (defaultValue: boolean): string =>
	`varsayılan: ${booleanLabel(defaultValue)}`;

/** The local-override line for a flag row — the tri-state, with `clear` reading as "no override". */
export const overrideLabel = (state: OverrideState): string => {
	switch (state) {
		case "on":
			return "yerel geçersiz kılma: açık";
		case "off":
			return "yerel geçersiz kılma: kapalı";
		case "clear":
			return "yerel geçersiz kılma: yok";
	}
};

/** The effective-value line — what the flag reads as in this browser right now. */
export const effectiveLabel = (value: boolean): string => `geçerli değer: ${booleanLabel(value)}`;

/** Turkish confirmation after a toggle writes the cookie, keyed on the action. */
export const overrideOutcomeMessage = ({key, state}: OverrideAction): string => {
	switch (state) {
		case "on":
			return `${key} bu tarayıcıda açık olarak geçersiz kılındı.`;
		case "off":
			return `${key} bu tarayıcıda kapalı olarak geçersiz kılındı.`;
		case "clear":
			return `${key} için yerel geçersiz kılma temizlendi.`;
	}
};

/** The button label for each tri-state control. */
export const actionButtonLabel = (state: OverrideState): string => {
	switch (state) {
		case "on":
			return "aç";
		case "off":
			return "kapat";
		case "clear":
			return "temizle";
	}
};
