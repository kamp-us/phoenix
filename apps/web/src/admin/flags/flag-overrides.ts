/**
 * This is a deliberate duplicate of the worker's cookie codec
 * (`worker/features/flagship/dev-override.ts`, #622). That module can't be imported here — it
 * pulls the alchemy `resources.ts` into the SPA bundle — so the same wire shape is re-stated:
 * `encodeURIComponent(JSON.stringify({[key]: boolean}))`. Keep the two in lockstep; a value
 * written here must read back through the worker's `parseOverrideCookie` verbatim.
 */

export const FLAG_OVERRIDE_COOKIE = "phoenix_flag_overrides";

export type FlagOverrides = Readonly<Record<string, boolean>>;

export const emptyOverrides: FlagOverrides = {};

export type OverrideState = "on" | "off" | "clear";

export interface OverrideAction {
	readonly key: string;
	readonly state: OverrideState;
}

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

export function overrideStateOf(overrides: FlagOverrides, key: string): OverrideState {
	if (!(key in overrides)) return "clear";
	return overrides[key] ? "on" : "off";
}

export function effectiveValue(
	defaultValue: boolean,
	overrides: FlagOverrides,
	key: string,
): boolean {
	const override = overrides[key];
	return override === undefined ? defaultValue : override;
}

/** Untrusted input: anything malformed degrades to "no override" rather than throwing. */
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

function readCookieValue(documentCookie: string, name: string): string | undefined {
	for (const part of documentCookie.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
	}
	return undefined;
}

export function encodeOverrideCookieValue(overrides: FlagOverrides): string {
	return encodeURIComponent(JSON.stringify(overrides));
}

/**
 * An empty map writes a `max-age=0` deletion, so clearing the last override removes the cookie
 * instead of leaving a `{}` husk. Deliberately NOT `Secure`: it must be readable under local
 * `alchemy dev`, which is http.
 */
export function serializeOverrideCookie(overrides: FlagOverrides): string {
	const attrs = "path=/; SameSite=Lax";
	if (Object.keys(overrides).length === 0) {
		return `${FLAG_OVERRIDE_COOKIE}=; ${attrs}; max-age=0`;
	}
	// One year — a local override is a deliberate dev/admin choice, not a session artifact.
	return `${FLAG_OVERRIDE_COOKIE}=${encodeOverrideCookieValue(overrides)}; ${attrs}; max-age=31536000`;
}

export const booleanLabel = (value: boolean): string => (value ? "açık" : "kapalı");

export const defaultLabel = (defaultValue: boolean): string =>
	`varsayılan: ${booleanLabel(defaultValue)}`;

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

export const effectiveLabel = (value: boolean): string => `geçerli değer: ${booleanLabel(value)}`;

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
