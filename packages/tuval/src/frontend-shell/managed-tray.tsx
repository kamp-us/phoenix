import type {KeyboardEvent, ReactNode} from "react";
import {Button} from "../../../../apps/web/src/components/ui/Button.js";
import {Surface} from "../../../../apps/web/src/components/ui/Card.js";

export type ManagedTrayPanelId =
	| "chat"
	| "sessions"
	| "contributions"
	| "restoration"
	| "lineage"
	| "discovery"
	| "extensions";

export interface ManagedTrayPanel {
	readonly id: ManagedTrayPanelId;
	readonly label: string;
	readonly available: boolean;
	readonly content: ReactNode;
}

export function ManagedTray({
	active,
	panels,
	onSelect,
	onClose,
}: {
	readonly active: ManagedTrayPanelId | null;
	readonly panels: ReadonlyArray<ManagedTrayPanel>;
	readonly onSelect: (panel: ManagedTrayPanelId) => void;
	readonly onClose: () => void;
}) {
	const activePanel = panels.find((panel) => panel.id === active && panel.available);
	const close = (): void => onClose();
	const openFromLauncher = (panel: ManagedTrayPanelId): void => {
		onSelect(panel);
		requestAnimationFrame(() =>
			document.querySelector<HTMLElement>("#managed-tray-close")?.focus(),
		);
	};
	const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
		if (event.key !== "Escape" || activePanel === undefined) return;
		event.preventDefault();
		event.stopPropagation();
		close();
	};

	return (
		<aside
			className="managed-tray"
			data-open={activePanel === undefined ? "false" : "true"}
			aria-label="Çalışma alanı tepsisi"
			onKeyDown={onKeyDown}
		>
			<nav className="managed-tray__switcher" aria-label="Tepsi panelleri">
				{panels.map((panel) => (
					<Button
						key={panel.id}
						id={`tray-open-${panel.id}`}
						type="button"
						variant={activePanel?.id === panel.id ? "primary" : "secondary"}
						aria-pressed={activePanel?.id === panel.id}
						aria-controls="managed-tray-panel"
						disabled={!panel.available}
						onClick={() => openFromLauncher(panel.id)}
					>
						{panel.label}
					</Button>
				))}
			</nav>
			<Surface
				as="section"
				id="managed-tray-panel"
				className="managed-tray__panel"
				aria-labelledby="managed-tray-title"
				data-mobile-panel={activePanel?.id === "extensions" ? "extensions" : "chat"}
				hidden={activePanel === undefined}
				tone="default"
				elevation="overlay"
				radius="lg"
				padding="md"
				border
			>
				<header className="managed-tray__header">
					<h2 id="managed-tray-title">{activePanel?.label ?? "Tepsi kapalı"}</h2>
					<Button id="managed-tray-close" type="button" variant="secondary" onClick={close}>
						Paneli kapat
					</Button>
				</header>
				<div className="managed-tray__body">
					{panels.map((panel) => (
						<div key={panel.id} hidden={activePanel?.id !== panel.id} data-tray-panel={panel.id}>
							{panel.content}
						</div>
					))}
				</div>
			</Surface>
		</aside>
	);
}
