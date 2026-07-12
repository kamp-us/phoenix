/**
 * The admin-console module registry (#2740, epic #2711) — the typed seam a console
 * module plugs into BY VALUE, modeled on the worker-side `fateModule` registry (features
 * compose into one merged host as values, never bespoke pages; `worker/features/fate/config.ts`).
 * A `ConsoleModule` is a plain value — a stable id, a Turkish nav label, and a lazily
 * rendered panel — so the shell can render the nav (id + label) without ever importing a
 * module's panel chunk until it's selected.
 *
 * The registry is a factory (`createConsoleRegistry`), so a test composes a fresh
 * registry with a fake module and asserts register/render in isolation — no shared mutable
 * singleton to pollute. The app-wide instance (`consoleRegistry`) is the one the real
 * modules register into; the shell reads it (or any injected registry).
 */
import type {ComponentType, LazyExoticComponent} from "react";

export interface ConsoleModule {
	/** Stable technical id — the registry key + the nav selection key. */
	readonly id: string;
	/** The Turkish nav label shown in the console shell. */
	readonly label: string;
	/** The module's panel, `React.lazy`-wrapped so its chunk loads only when selected. */
	readonly panel: LazyExoticComponent<ComponentType>;
}

export interface ConsoleRegistry {
	/** Compose a module into the host. Throws on a duplicate id — two modules can't own one nav key. */
	register(module: ConsoleModule): void;
	/** The registered modules, in registration order (nav order). */
	list(): readonly ConsoleModule[];
}

export function createConsoleRegistry(): ConsoleRegistry {
	// A Map keyed by id: insertion-ordered (nav order) AND collision-detecting in one
	// structure — a duplicate id is a wiring bug, not a silent last-write-wins.
	const modules = new Map<string, ConsoleModule>();
	return {
		register(module) {
			if (modules.has(module.id)) {
				throw new Error(`console module already registered: ${module.id}`);
			}
			modules.set(module.id, module);
		},
		list() {
			return [...modules.values()];
		},
	};
}

/**
 * Resolve the active module from the registry's list + the selected id — the pure render
 * decision the shell delegates to, so "which panel shows" is unit-testable without a DOM.
 * Falls back to the first module when nothing is selected or the selection is unknown
 * (a stale/absent nav key never blanks the console). `null` only when the host is empty.
 */
export function selectActiveModule(
	modules: readonly ConsoleModule[],
	selectedId: string | null,
): ConsoleModule | null {
	return modules.find((m) => m.id === selectedId) ?? modules[0] ?? null;
}

/** The app-wide registry the real console modules register into (see `app-modules.ts`). */
export const consoleRegistry = createConsoleRegistry();
