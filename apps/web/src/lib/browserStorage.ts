/**
 * The one guarded read of `window.localStorage` (#7728), behind the
 * `Storage | undefined` the `*Storage` helpers already take.
 *
 * Two ways the property itself fails before any read: a Safari private window (and
 * Chrome with site data blocked) throws on the access, and a runtime can simply not
 * define it. Both must degrade to "no persistence", never to a thrown render.
 */
export function browserStorage(): Storage | undefined {
	if (typeof window === "undefined") return undefined;
	try {
		return window.localStorage ?? undefined;
	} catch {
		return undefined;
	}
}
