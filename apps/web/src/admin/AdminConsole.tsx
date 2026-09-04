import {Button} from "@kampus/design";
import {Suspense, useState} from "react";
import {useT} from "../i18n";
import {consoleRegistry} from "./app-modules.ts";
import {type ConsoleRegistry, selectActiveModule} from "./module-registry.ts";

export function AdminConsole({registry = consoleRegistry}: {readonly registry?: ConsoleRegistry}) {
	const t = useT();
	const modules = registry.list();
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const active = selectActiveModule(modules, selectedId);
	const Panel = active?.panel ?? null;

	return (
		<section className="kp-admin" aria-label={t("admin.console.label")} data-testid="admin-console">
			<nav className="kp-admin__nav" aria-label={t("admin.console.nav")}>
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
						{t(module.labelKey)}
					</Button>
				))}
			</nav>
			<div className="kp-admin__panel" data-testid="admin-panel">
				{Panel ? (
					<Suspense fallback={<p>{t("admin.console.loading")}</p>}>
						<Panel />
					</Suspense>
				) : (
					<p>{t("admin.console.empty")}</p>
				)}
			</div>
		</section>
	);
}

export default AdminConsole;
