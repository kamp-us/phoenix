import {Boxes, CircleAlert, PackageCheck} from "lucide-react";
import {useCallback, useEffect, useRef, useState} from "react";
import {Badge} from "../../../../apps/web/src/components/ui/Badge.js";
import {Card} from "../../../../apps/web/src/components/ui/Card.js";
import {type ContributionDiagnostic, ContributionRegistry} from "./contribution-registry.js";

export interface ContributionState {
	readonly registry: ContributionRegistry;
	readonly loading: boolean;
	readonly reload: () => Promise<void>;
	readonly reportFailure: (failure: ContributionDiagnostic) => void;
}

export function useContributions(): ContributionState {
	const [registry, setRegistry] = useState(() => ContributionRegistry.empty());
	const [loading, setLoading] = useState(true);
	const registryRef = useRef(registry);
	const reloadGeneration = useRef(0);
	registryRef.current = registry;
	const reload = useCallback(async () => {
		const generation = reloadGeneration.current + 1;
		reloadGeneration.current = generation;
		setLoading(true);
		try {
			const response = await fetch("/api/contributions", {
				cache: "no-store",
				credentials: "same-origin",
				headers: {accept: "application/json"},
			});
			if (
				!response.ok ||
				!/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "")
			) {
				if (generation === reloadGeneration.current) {
					setRegistry(ContributionRegistry.failed("catalog-unavailable", registryRef.current));
				}
				return;
			}
			const next = await ContributionRegistry.load(await response.json(), registryRef.current);
			if (generation === reloadGeneration.current) setRegistry(next);
		} catch {
			if (generation === reloadGeneration.current) {
				setRegistry(ContributionRegistry.failed("catalog-unavailable", registryRef.current));
			}
		} finally {
			if (generation === reloadGeneration.current) setLoading(false);
		}
	}, []);
	useEffect(() => void reload(), [reload]);
	const reportFailure = useCallback((failure: ContributionDiagnostic) => {
		setRegistry((current) => current.withDiagnostic(failure));
	}, []);
	return {registry, loading, reload, reportFailure};
}

const kindLabel = {node: "düğüm", edge: "bağ", panel: "panel"} as const;

export function ContributionStatus({state}: {readonly state: ContributionState}) {
	const {registry, loading} = state;
	return (
		<Card
			as="section"
			className="contribution-status"
			aria-labelledby="contribution-status-title"
			aria-busy={loading}
		>
			<header>
				<Boxes size={16} aria-hidden="true" />
				<h2 id="contribution-status-title">Paket katkıları</h2>
				<Badge>{loading ? "Yükleniyor" : `${registry.loaded.length} etkin`}</Badge>
			</header>
			{registry.loaded.length === 0 && registry.diagnostics.length === 0 && !loading ? (
				<p>Etkin pi paketleri bu tuvale ek bir görünüm sağlamıyor.</p>
			) : null}
			{registry.loaded.length === 0 ? null : (
				<ul className="contribution-status__loaded" aria-label="Etkin paket katkıları">
					{registry.loaded.map((entry) => (
						<li key={`${entry.packageName}:${entry.kind}:${entry.key}`}>
							<PackageCheck size={14} aria-hidden="true" />
							<span>
								<strong>{entry.packageName}</strong> · {entry.key} · {kindLabel[entry.kind]}
							</span>
						</li>
					))}
				</ul>
			)}
			{registry.diagnostics.length === 0 ? null : (
				<div
					className="contribution-status__diagnostics"
					role="status"
					aria-live="polite"
					aria-atomic="true"
				>
					<strong>
						<CircleAlert size={14} aria-hidden="true" /> Yalıtılan katkılar
					</strong>
					<ul>
						{registry.diagnostics.map((item, index) => (
							<li key={`${item.packageName}:${item.code}:${item.key ?? index}`}>
								<strong>{item.packageName}</strong>
								<span>{item.message}</span>
							</li>
						))}
					</ul>
				</div>
			)}
		</Card>
	);
}
