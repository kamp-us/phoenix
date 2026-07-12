/**
 * `AdminConsole` — the admin-console shell (#2740, epic #2711): the extensible host that
 * renders the module registry as a nav + a panel. This is the lazy-loaded admin-only
 * chunk (`AdminConsoleRoute` mounts it only past the admin probe), so no console/module
 * code reaches a non-admin's bundle.
 *
 * The shell is registry-driven, not per-module wired: it reads `consoleRegistry.list()`
 * (composed by value in `app-modules.ts`) and delegates "which panel is active" to the
 * pure `selectActiveModule`. Adding a module is one registry entry — the shell renders it
 * with zero changes. Its panel is `React.lazy`-wrapped, so a module's chunk loads only
 * when its nav entry is selected. Lowercase-Turkish copy per the design law.
 */
import {Suspense, useState} from "react";
import {consoleRegistry} from "./app-modules.ts";
import {type ConsoleRegistry, selectActiveModule} from "./module-registry.ts";

export function AdminConsole({registry = consoleRegistry}: {readonly registry?: ConsoleRegistry}) {
	const modules = registry.list();
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const active = selectActiveModule(modules, selectedId);
	const Panel = active?.panel ?? null;

	return (
		<section className="kp-admin" aria-label="yönetim konsolu" data-testid="admin-console">
			<nav className="kp-admin__nav" aria-label="konsol modülleri">
				{modules.map((module) => (
					<button
						key={module.id}
						type="button"
						aria-current={active?.id === module.id ? "page" : undefined}
						onClick={() => setSelectedId(module.id)}
						data-testid={`admin-nav-${module.id}`}
					>
						{module.label}
					</button>
				))}
			</nav>
			<div className="kp-admin__panel" data-testid="admin-panel">
				{Panel ? (
					<Suspense fallback={<p>yükleniyor…</p>}>
						<Panel />
					</Suspense>
				) : (
					<p>henüz modül yok.</p>
				)}
			</div>
		</section>
	);
}

export default AdminConsole;
