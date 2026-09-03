import {Button} from "@kampus/design";
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
					<Button
						key={module.id}
						type="button"
						variant="tertiary"
						size="sm"
						aria-current={active?.id === module.id ? "page" : undefined}
						onClick={() => setSelectedId(module.id)}
						data-testid={`admin-nav-${module.id}`}
					>
						{module.label}
					</Button>
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
