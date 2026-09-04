/**
 * The whole message-format surface: `{name}` substitution. No ICU parser, no runtime
 * dependency (ADR 0347) — plurals go through `plural.ts` instead of a `{n, plural, …}` arm.
 */

export type MessageParams = Readonly<Record<string, string | number>>;

const PLACEHOLDER = /\{(\w+)\}/g;

/** An unsupplied placeholder is left verbatim, so a missing param reads as a bug, not a blank. */
export function interpolate(message: string, params?: MessageParams): string {
	if (!params) return message;
	return message.replace(PLACEHOLDER, (whole, name: string) =>
		Object.hasOwn(params, name) ? String(params[name]) : whole,
	);
}
