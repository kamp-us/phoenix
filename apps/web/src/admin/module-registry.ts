import type {ComponentType, LazyExoticComponent} from "react";

export interface ConsoleModule {
	readonly id: string;
	readonly label: string;
	readonly panel: LazyExoticComponent<ComponentType>;
}

export interface ConsoleRegistry {
	register(module: ConsoleModule): void;
	/** In registration order — that order is the nav order. */
	list(): readonly ConsoleModule[];
}

export function createConsoleRegistry(): ConsoleRegistry {
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

/** Falls back to the first module so a stale or absent nav key never blanks the console. */
export function selectActiveModule(
	modules: readonly ConsoleModule[],
	selectedId: string | null,
): ConsoleModule | null {
	return modules.find((m) => m.id === selectedId) ?? modules[0] ?? null;
}

export const consoleRegistry = createConsoleRegistry();
