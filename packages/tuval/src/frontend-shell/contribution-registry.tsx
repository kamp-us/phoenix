import {type Edge, type EdgeProps, type Node, type NodeProps, Panel} from "@xyflow/react";
import {Component, type ComponentType, createElement, type ErrorInfo, type ReactNode} from "react";

export type ContributionKind = "node" | "edge" | "panel";

export interface ContributionNodeData extends Record<string, unknown> {
	readonly contributionKey: string;
	readonly packageName: string;
}

export interface ContributionEdgeData extends Record<string, unknown> {
	readonly contributionKey: string;
	readonly packageName: string;
}

export type ContributionCanvasNode = Node<ContributionNodeData, string>;
export type ContributionCanvasEdge = Edge<ContributionEdgeData, string>;
type ContributionNodeProps = NodeProps<ContributionCanvasNode>;
type ContributionEdgeProps = EdgeProps<ContributionCanvasEdge>;
type ContributionPanelProps = Readonly<Record<string, never>>;
type ContributionRenderProps =
	| ContributionNodeProps
	| ContributionEdgeProps
	| ContributionPanelProps;

type ContributionRender = (
	props: ContributionRenderProps,
	api: {readonly createElement: typeof createElement},
) => ReactNode;

export interface ContributionDiagnostic {
	readonly packageName: string;
	readonly code:
		| "catalog-unavailable"
		| "catalog-invalid"
		| "unsupported-version"
		| "duplicate-key"
		| "built-in-key"
		| "asset-unavailable"
		| "asset-not-javascript"
		| "module-load-failed"
		| "module-invalid"
		| "render-failed"
		| "unloaded";
	readonly message: string;
	readonly kind?: ContributionKind;
	readonly key?: string;
}

interface CatalogEntry {
	readonly kind: ContributionKind;
	readonly key: string;
	readonly asset: string;
	readonly packageName: string;
}

interface CatalogDiagnostic {
	readonly packageName: string;
	readonly reason: string;
	readonly message: string;
	readonly kind?: ContributionKind;
	readonly key?: string;
}

interface Catalog {
	readonly contractVersion: 1;
	readonly frontend: ReadonlyArray<CatalogEntry>;
	readonly diagnostics: ReadonlyArray<CatalogDiagnostic>;
}

interface RegisteredContribution extends CatalogEntry {
	readonly render: ContributionRender;
}

const BUILT_IN_KEYS: Readonly<Record<ContributionKind, ReadonlySet<string>>> = {
	node: new Set(["session"]),
	edge: new Set(["relationship"]),
	panel: new Set(["canvas-controls", "canvas-legend"]),
};

const publicName = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const publicKey = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const assetPath = /^\/api\/contribution-assets\/v1-\d+\.js$/;
const isContributionKind = (value: unknown): value is ContributionKind =>
	value === "node" || value === "edge" || value === "panel";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, expected: ReadonlyArray<string>): boolean => {
	const actual = Object.keys(value).sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const knownKeys = (value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean =>
	Object.keys(value).every((key) => allowed.has(key));

const decodeEntry = (value: unknown): CatalogEntry | undefined => {
	if (!isRecord(value) || !exactKeys(value, ["asset", "key", "kind", "packageName"])) return;
	if (
		!isContributionKind(value.kind) ||
		typeof value.key !== "string" ||
		!publicKey.test(value.key) ||
		typeof value.asset !== "string" ||
		!assetPath.test(value.asset) ||
		typeof value.packageName !== "string" ||
		!publicName.test(value.packageName)
	) {
		return;
	}
	return {
		kind: value.kind,
		key: value.key,
		asset: value.asset,
		packageName: value.packageName,
	};
};

const diagnosticKeys = new Set(["key", "kind", "message", "packageName", "reason"]);

const decodeDiagnostic = (value: unknown): CatalogDiagnostic | undefined => {
	if (
		!isRecord(value) ||
		!knownKeys(value, diagnosticKeys) ||
		typeof value.packageName !== "string" ||
		!publicName.test(value.packageName) ||
		typeof value.reason !== "string" ||
		typeof value.message !== "string"
	) {
		return;
	}
	const kind = value.kind === undefined ? undefined : value.kind;
	const key = value.key === undefined ? undefined : value.key;
	if (
		(kind !== undefined && !isContributionKind(kind)) ||
		(key !== undefined && (typeof key !== "string" || !publicKey.test(key)))
	) {
		return;
	}
	return {
		packageName: value.packageName,
		reason: value.reason,
		message: value.message,
		...(kind === undefined ? {} : {kind}),
		...(key === undefined ? {} : {key}),
	};
};

const decodeCatalog = (value: unknown): Catalog | undefined => {
	if (!isRecord(value) || !exactKeys(value, ["contractVersion", "diagnostics", "frontend"])) return;
	if (
		value.contractVersion !== 1 ||
		!Array.isArray(value.frontend) ||
		!Array.isArray(value.diagnostics)
	)
		return;
	const frontend: Array<CatalogEntry> = [];
	for (const candidate of value.frontend) {
		const entry = decodeEntry(candidate);
		if (entry === undefined) return;
		frontend.push(entry);
	}
	const diagnostics: Array<CatalogDiagnostic> = [];
	for (const candidate of value.diagnostics) {
		const entry = decodeDiagnostic(candidate);
		if (entry === undefined) return;
		diagnostics.push(entry);
	}
	return {contractVersion: 1, frontend, diagnostics};
};

const browserMessage = (code: ContributionDiagnostic["code"], key?: string): string => {
	const subject = key === undefined ? "Paket katkısı" : `Katkı ${key}`;
	switch (code) {
		case "catalog-unavailable":
			return "Katkı kataloğu yüklenemedi";
		case "catalog-invalid":
			return "Katkı kataloğu doğrulanamadı";
		case "unsupported-version":
			return `${subject} desteklenmeyen bir sözleşme sürümü kullanıyor`;
		case "duplicate-key":
			return `${subject} başka bir katkıyla aynı anahtarı kullanıyor`;
		case "built-in-key":
			return `${subject} yerleşik bir Tuval anahtarını değiştirmeye çalışıyor`;
		case "asset-unavailable":
			return `${subject} dosyasına ulaşılamadı`;
		case "asset-not-javascript":
			return `${subject} JavaScript olmayan bir dosya döndürdü`;
		case "module-load-failed":
			return `${subject} modülü yüklenemedi`;
		case "module-invalid":
			return `${subject} kapalı modül sözleşmesini karşılamıyor`;
		case "render-failed":
			return `${subject} çizilirken durduruldu`;
		case "unloaded":
			return `${subject} kaldırıldı`;
	}
};

const backendCode = (reason: string): ContributionDiagnostic["code"] => {
	if (reason === "duplicate-key" || reason === "shadowed-key") return "duplicate-key";
	if (reason === "asset-unavailable") return "asset-unavailable";
	if (reason === "manifest-invalid") return "unsupported-version";
	return "module-invalid";
};

export interface ContributionModuleTransport {
	readonly read: (asset: string) => Promise<{readonly ok: boolean; readonly contentType: string}>;
	readonly importModule: (asset: string) => Promise<unknown>;
}

const browserTransport = (): ContributionModuleTransport => ({
	read: async (asset) => {
		const response = await fetch(asset, {cache: "no-store", credentials: "same-origin"});
		return {ok: response.ok, contentType: response.headers.get("content-type") ?? ""};
	},
	importModule: async (asset) =>
		import(/* @vite-ignore */ new URL(asset, window.location.origin).href),
});

const isContributionRender = (value: unknown): value is ContributionRender =>
	typeof value === "function";

const decodeModule = (
	value: unknown,
	entry: CatalogEntry,
): {readonly render: ContributionRender} | {readonly code: ContributionDiagnostic["code"]} => {
	if (!isRecord(value) || !exactKeys(value, ["default"])) return {code: "module-invalid"};
	const definition = value.default;
	if (!isRecord(definition) || !exactKeys(definition, ["contractVersion", "kind", "render"])) {
		return {code: "module-invalid"};
	}
	if (definition.contractVersion !== 1) return {code: "unsupported-version"};
	if (definition.kind !== entry.kind || !isContributionRender(definition.render)) {
		return {code: "module-invalid"};
	}
	return {render: definition.render};
};

const diagnostic = (
	packageName: string,
	code: ContributionDiagnostic["code"],
	entry?: Pick<CatalogEntry, "kind" | "key">,
): ContributionDiagnostic => ({
	packageName,
	code,
	message: browserMessage(code, entry?.key),
	...(entry === undefined ? {} : {kind: entry.kind, key: entry.key}),
});

export class ContributionRegistry {
	readonly nodes: ReadonlyMap<string, RegisteredContribution>;
	readonly edges: ReadonlyMap<string, RegisteredContribution>;
	readonly panels: ReadonlyMap<string, RegisteredContribution>;
	readonly diagnostics: ReadonlyArray<ContributionDiagnostic>;
	readonly packages: ReadonlySet<string>;
	readonly revision: number;

	private constructor(
		entries: ReadonlyArray<RegisteredContribution>,
		diagnostics: ReadonlyArray<ContributionDiagnostic>,
		packages: ReadonlySet<string>,
		revision: number,
	) {
		this.nodes = new Map(
			entries.filter(({kind}) => kind === "node").map((entry) => [entry.key, entry]),
		);
		this.edges = new Map(
			entries.filter(({kind}) => kind === "edge").map((entry) => [entry.key, entry]),
		);
		this.panels = new Map(
			entries.filter(({kind}) => kind === "panel").map((entry) => [entry.key, entry]),
		);
		this.diagnostics = diagnostics;
		this.packages = packages;
		this.revision = revision;
	}

	static empty(): ContributionRegistry {
		return new ContributionRegistry([], [], new Set(), 0);
	}

	static failed(
		code: "catalog-unavailable" | "catalog-invalid",
		previous = ContributionRegistry.empty(),
	): ContributionRegistry {
		return new ContributionRegistry(
			[],
			[
				diagnostic("tuval", code),
				...[...previous.packages].map((name) => diagnostic(name, "unloaded")),
			],
			new Set(),
			previous.revision + 1,
		);
	}

	static async load(
		value: unknown,
		previous = ContributionRegistry.empty(),
		transport: ContributionModuleTransport = browserTransport(),
	): Promise<ContributionRegistry> {
		const catalog = decodeCatalog(value);
		if (catalog === undefined) return ContributionRegistry.failed("catalog-invalid", previous);
		const packageNames = new Set(catalog.frontend.map(({packageName}) => packageName));
		for (const item of catalog.diagnostics) packageNames.add(item.packageName);
		const diagnostics: Array<ContributionDiagnostic> = catalog.diagnostics.map((item) => {
			const code = backendCode(item.reason);
			return diagnostic(
				item.packageName,
				code,
				item.kind === undefined || item.key === undefined
					? undefined
					: {kind: item.kind, key: item.key},
			);
		});
		for (const packageName of previous.packages) {
			if (!packageNames.has(packageName)) diagnostics.push(diagnostic(packageName, "unloaded"));
		}
		const entries: Array<RegisteredContribution> = [];
		const seen = new Set<string>();
		const grouped = new Map<string, Array<CatalogEntry>>();
		for (const entry of catalog.frontend) {
			const current = grouped.get(entry.packageName) ?? [];
			current.push(entry);
			grouped.set(entry.packageName, current);
		}
		for (const [packageName, packageEntries] of grouped) {
			let rejection: ContributionDiagnostic | undefined;
			const loaded: Array<RegisteredContribution> = [];
			for (const entry of packageEntries) {
				const identity = `${entry.kind}:${entry.key}`;
				if (BUILT_IN_KEYS[entry.kind].has(entry.key))
					rejection = diagnostic(packageName, "built-in-key", entry);
				else if (
					seen.has(identity) ||
					packageEntries.filter((candidate) => `${candidate.kind}:${candidate.key}` === identity)
						.length > 1
				)
					rejection = diagnostic(packageName, "duplicate-key", entry);
				if (rejection !== undefined) break;
				let probe: {readonly ok: boolean; readonly contentType: string};
				try {
					probe = await transport.read(entry.asset);
				} catch {
					rejection = diagnostic(packageName, "asset-unavailable", entry);
					break;
				}
				if (!probe.ok) {
					rejection = diagnostic(packageName, "asset-unavailable", entry);
					break;
				}
				if (!/^(?:text|application)\/javascript(?:;|$)/i.test(probe.contentType)) {
					rejection = diagnostic(packageName, "asset-not-javascript", entry);
					break;
				}
				let module: unknown;
				try {
					module = await transport.importModule(entry.asset);
				} catch {
					rejection = diagnostic(packageName, "module-load-failed", entry);
					break;
				}
				const decoded = decodeModule(module, entry);
				if ("code" in decoded) {
					rejection = diagnostic(packageName, decoded.code, entry);
					break;
				}
				loaded.push({...entry, render: decoded.render});
			}
			if (rejection !== undefined) {
				diagnostics.push(rejection);
				continue;
			}
			for (const entry of loaded) seen.add(`${entry.kind}:${entry.key}`);
			entries.push(...loaded);
		}
		return new ContributionRegistry(entries, diagnostics, packageNames, previous.revision + 1);
	}

	withDiagnostic(failure: ContributionDiagnostic): ContributionRegistry {
		if (
			this.diagnostics.some(
				(item) =>
					item.packageName === failure.packageName &&
					item.code === failure.code &&
					item.key === failure.key,
			)
		)
			return this;
		return new ContributionRegistry(
			this.loaded,
			[...this.diagnostics, failure],
			this.packages,
			this.revision,
		);
	}

	get loaded(): ReadonlyArray<RegisteredContribution> {
		return [...this.nodes.values(), ...this.edges.values(), ...this.panels.values()];
	}
}

interface ContributionBoundaryProps {
	readonly entry: RegisteredContribution;
	readonly children: ReactNode;
	readonly onFailure: (failure: ContributionDiagnostic) => void;
}

interface ContributionBoundaryState {
	readonly entry: RegisteredContribution;
	readonly failed: boolean;
}

class ContributionBoundary extends Component<ContributionBoundaryProps, ContributionBoundaryState> {
	override state = {entry: this.props.entry, failed: false};
	static getDerivedStateFromProps(
		props: ContributionBoundaryProps,
		state: ContributionBoundaryState,
	): ContributionBoundaryState | null {
		return props.entry === state.entry ? null : {entry: props.entry, failed: false};
	}
	static getDerivedStateFromError() {
		return {failed: true};
	}
	override componentDidCatch(_error: Error, _info: ErrorInfo) {
		this.props.onFailure(
			diagnostic(this.props.entry.packageName, "render-failed", this.props.entry),
		);
	}
	override render() {
		return this.state.failed ? (
			<span role="status" data-package={this.props.entry.packageName}>
				{this.props.entry.packageName} paketi:{" "}
				{browserMessage("render-failed", this.props.entry.key)}
			</span>
		) : (
			this.props.children
		);
	}
}

const ContributionRender = ({
	entry,
	props,
}: {
	readonly entry: RegisteredContribution;
	readonly props: ContributionRenderProps;
}) => entry.render(props, {createElement});

const entryLifecycleKey = (entry: RegisteredContribution): string =>
	`${entry.packageName}:${entry.kind}:${entry.key}:${entry.asset}`;

export const contributionNodeTypes = (
	registry: ContributionRegistry,
	onFailure: (failure: ContributionDiagnostic) => void,
): Readonly<Record<string, ComponentType<ContributionNodeProps>>> =>
	Object.fromEntries(
		[...registry.nodes].map(([key, entry]) => [
			key,
			(props: ContributionNodeProps) => (
				<div className="package-node" data-package={entry.packageName}>
					<span className="package-attribution">{entry.packageName}</span>
					<ContributionBoundary key={entryLifecycleKey(entry)} entry={entry} onFailure={onFailure}>
						<ContributionRender entry={entry} props={props} />
					</ContributionBoundary>
				</div>
			),
		]),
	);

export const contributionEdgeTypes = (
	registry: ContributionRegistry,
	onFailure: (failure: ContributionDiagnostic) => void,
): Readonly<Record<string, ComponentType<ContributionEdgeProps>>> =>
	Object.fromEntries(
		[...registry.edges].map(([key, entry]) => [
			key,
			(props: ContributionEdgeProps) => (
				<ContributionBoundary key={entryLifecycleKey(entry)} entry={entry} onFailure={onFailure}>
					<ContributionRender entry={entry} props={props} />
				</ContributionBoundary>
			),
		]),
	);

export const ContributionPanels = ({
	registry,
	onFailure,
}: {
	readonly registry: ContributionRegistry;
	readonly onFailure: (failure: ContributionDiagnostic) => void;
}) =>
	registry.panels.size === 0 ? null : (
		<Panel position="top-right" className="package-panels" aria-label="Paket panelleri">
			{[...registry.panels.values()].map((entry) => (
				<div
					className="package-panel"
					data-package={entry.packageName}
					key={`${entry.packageName}:${entry.key}`}
				>
					<span className="package-attribution">{entry.packageName}</span>
					<ContributionBoundary key={entryLifecycleKey(entry)} entry={entry} onFailure={onFailure}>
						<ContributionRender entry={entry} props={{}} />
					</ContributionBoundary>
				</div>
			))}
		</Panel>
	);
