import type {Density} from "./density";

export const DENSITY_STORAGE_KEY = "kampus.density";

const VALID: ReadonlySet<string> = new Set<Density>(["compact", "normal", "spacious"]);

function isDensity(value: string | null): value is Density {
	return value !== null && VALID.has(value);
}

/** Read the persisted density, falling back to `fallback` for missing/garbage/unavailable storage. */
export function readStoredDensity(storage: Storage | undefined, fallback: Density): Density {
	if (!storage) return fallback;
	try {
		const raw = storage.getItem(DENSITY_STORAGE_KEY);
		return isDensity(raw) ? raw : fallback;
	} catch {
		return fallback;
	}
}

/** Persist the density. A throwing/unavailable storage (private mode, quota) is swallowed. */
export function writeStoredDensity(storage: Storage | undefined, density: Density): void {
	if (!storage) return;
	try {
		storage.setItem(DENSITY_STORAGE_KEY, density);
	} catch {
		// A failed write only costs persistence, never the in-memory density.
	}
}
