import {AlertTriangle, CheckCircle2, RotateCcw} from "lucide-react";
import {Badge} from "../../../../apps/web/src/components/ui/Badge.js";
import {Button} from "../../../../apps/web/src/components/ui/Button.js";
import {Card} from "../../../../apps/web/src/components/ui/Card.js";
import type {ResilienceDiagnostic, RestorationSnapshot} from "../shared/resilience.js";

export type SelectionRestoration =
	| {readonly _tag: "idle"}
	| {readonly _tag: "restored"; readonly sessionId: string}
	| {readonly _tag: "unavailable"; readonly sessionId: string; readonly reason: string};

const stageLabels = {
	discovery: "Oturumlar",
	lineage: "Kalıcı bağlar",
	selection: "Seçili sohbet",
	settings: "Ayarlar",
	"package-registrations": "Paket kayıtları",
	"extension-ui-current": "Extension durumu",
} as const;

const categoryLabels = {
	startup: "Başlatma",
	protocol: "Protokol",
	lineage: "Oturum bağları",
	persistence: "Kalıcı çalışma alanı",
	package: "Paket",
	"ui-bridge": "Extension UI",
} as const;

const diagnosticKey = (diagnostic: ResilienceDiagnostic, index: number): string =>
	`${diagnostic.category}:${diagnostic.code}:${diagnostic.sessionId ?? ""}:${diagnostic.packageName ?? ""}:${diagnostic.sourceId ?? ""}:${index}`;

export function RestorationStatus({
	snapshot,
	failure,
	selection,
	onUseFirstSession,
}: {
	readonly snapshot: RestorationSnapshot | null;
	readonly failure: string | null;
	readonly selection: SelectionRestoration;
	readonly onUseFirstSession: () => void;
}) {
	const degraded = snapshot?.stages.filter(({status}) => status === "degraded") ?? [];
	const diagnostics = snapshot?.diagnostics ?? [];
	const unavailable = selection._tag === "unavailable";
	if (failure === null && degraded.length === 0 && diagnostics.length === 0 && !unavailable) {
		return snapshot === null ? null : (
			<div className="restoration-summary" role="status" aria-live="polite">
				<CheckCircle2 size={14} aria-hidden="true" />
				<span>Çalışma alanı geri yüklendi</span>
				<Badge>{snapshot.packageRegistrations.length} paket</Badge>
			</div>
		);
	}
	return (
		<Card as="section" className="restoration-status" aria-labelledby="restoration-title">
			<header>
				<RotateCcw size={16} aria-hidden="true" />
				<h2 id="restoration-title">Geri yükleme durumu</h2>
				<Badge>{diagnostics.length + degraded.length + (failure === null ? 0 : 1)} inceleme</Badge>
			</header>
			<p>Sağlıklı oturumlar ve bağlar görünür kalır; her sorun kendi kaynağında ele alınır.</p>
			{failure === null ? null : (
				<div className="restoration-status__problem" role="alert">
					<strong>Geri yükleme özeti okunamadı</strong>
					<span>{failure}</span>
					<small>Sunucuyu doğrulayıp sayfayı yenile.</small>
				</div>
			)}
			{unavailable ? (
				<div className="restoration-status__problem" role="status">
					<strong>Önceki sohbet kullanılamıyor</strong>
					<span>{selection.reason}</span>
					<small>Oturum: {selection.sessionId}</small>
					<Button type="button" variant="secondary" onClick={onUseFirstSession}>
						İlk kullanılabilir oturumu seç
					</Button>
				</div>
			) : null}
			{degraded.length === 0 ? null : (
				<ul className="restoration-status__stages" aria-label="Eksik geri yükleme aşamaları">
					{degraded.map(({stage}) => (
						<li key={stage}>
							<AlertTriangle size={14} aria-hidden="true" /> {stageLabels[stage]}
						</li>
					))}
				</ul>
			)}
			{diagnostics.length === 0 ? null : (
				<ul className="restoration-status__diagnostics" aria-label="Geri yükleme tanıları">
					{diagnostics.map((diagnostic, index) => (
						<li key={diagnosticKey(diagnostic, index)}>
							<strong>{categoryLabels[diagnostic.category]}</strong>
							<span>{diagnostic.message}</span>
							<small>{diagnostic.action}</small>
						</li>
					))}
				</ul>
			)}
		</Card>
	);
}
