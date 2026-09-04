/**
 * Sözlük home page. No local search box — that folded into the global ⌘K (#2995). The
 * `?harf=` letter filter narrows only the already-loaded first page, client-side, which
 * is why the filtered-to-zero copy names that scope ("ilk sayfada") not the whole corpus.
 */
import * as React from "react";
import {useListView, useRequest, useView, type ViewRef} from "react-fate";
import {useSearchParams} from "react-router";
import {TermRow, TermRowView} from "../components/sozluk/TermRow";
import {Screen} from "../fate/Screen";
import {useT} from "../i18n";
import {sozlukPageEmptyLabel} from "../lib/sozlukPageEmptyLabel";
import "./SozlukHome.css";

/** A connection "view" is a plain `{items: {node: View}}` selection, not a `view<T>()`. */
const TermConnectionView = {items: {node: TermRowView}} as const;

const HOME_PAGE_SIZE = 5;

const homeRequest = {
	recentTerms: {list: TermConnectionView, args: {first: HOME_PAGE_SIZE}},
	popularTerms: {list: TermConnectionView, args: {first: HOME_PAGE_SIZE}},
} as const;

type TermConnection = ReturnType<typeof useRequest<typeof homeRequest>>["recentTerms"];

// The letter lives in the URL, not component state, so the filter is shareable and
// back-button-correct.
export function SozlukHome() {
	const [params] = useSearchParams();
	const letter = params.get("harf") ?? undefined;

	return (
		<div className="kp-page">
			<div className="kp-page__inner">
				<Screen
					fallback={<SozlukHomeChrome status="loading">{null}</SozlukHomeChrome>}
					error={({code}) => (
						<SozlukHomeChrome status="error" errorMessage={code.toLowerCase()}>
							{null}
						</SozlukHomeChrome>
					)}
				>
					<SozlukHomeContent letter={letter} />
				</Screen>
			</div>
		</div>
	);
}

interface ContentProps {
	letter: string | undefined;
}

function SozlukHomeContent({letter}: ContentProps) {
	const {recentTerms, popularTerms} = useRequest(homeRequest);

	return (
		<SozlukHomeChrome status="ok">
			<RecentColumn connection={recentTerms} letter={letter} />
			<PopularColumn connection={popularTerms} letter={letter} />
		</SozlukHomeChrome>
	);
}

interface ChromeProps {
	status: "loading" | "ok" | "error";
	errorMessage?: string;
	children: React.ReactNode;
}

function SozlukHomeChrome({status, errorMessage, children}: ChromeProps) {
	const t = useT();
	const totalsLine =
		status === "ok"
			? ""
			: status === "loading"
				? t("sozluk.home.loading")
				: t("sozluk.home.loadFailedShort");

	return (
		<>
			<header className="kp-sozluk-home__masthead">
				<div>
					<h1 className="kp-sozluk-home__title">
						{t("sozluk.home.title")} {totalsLine ? <small>{totalsLine}</small> : null}
					</h1>
				</div>
				{/* The alphabet + create CTA live in the persistent Subnav zone (#2602), so the
				    masthead paints neither — no duplicate. */}
			</header>

			{status === "error" ? (
				<p style={{font: "var(--t-meta)", color: "var(--danger)", padding: "var(--s-3) 0"}}>
					{t("sozluk.home.loadFailed", {code: errorMessage ?? ""})}
				</p>
			) : null}

			<div className="kp-sozluk-home__columns">{children}</div>
		</>
	);
}

// Each row reads its own fate view, so match state can only travel up per-row; this hook
// owns the map and separates a genuinely empty connection from a filtered-to-zero one.
function useFilteredColumn(items: readonly {node: ViewRef<"Term">}[]) {
	const [matches, setMatches] = React.useState<Record<string, boolean>>({});
	const onMatch = React.useCallback((id: string, matched: boolean) => {
		setMatches((prev) => (prev[id] === matched ? prev : {...prev, [id]: matched}));
	}, []);
	const hasMatch = items.some(({node}) => matches[String(node.id)]);
	const state: "empty" | "no-match" | "ok" =
		items.length === 0 ? "empty" : hasMatch ? "ok" : "no-match";
	return {onMatch, state};
}

interface ColumnProps {
	connection: TermConnection;
	letter: string | undefined;
}

function RecentColumn({connection, letter}: ColumnProps) {
	const t = useT();
	const [items] = useListView(TermConnectionView, connection);
	const {onMatch, state} = useFilteredColumn(items);

	return (
		<section>
			<header className="kp-sozluk-home__col-head">
				<span className="title">{t("sozluk.home.recent")}</span>
				<span>{t("sozluk.home.recentWindow")}</span>
			</header>
			<div className="kp-sozluk-list">
				{items.map(({node}) => (
					<FilterableTermRow key={node.id} node={node} letter={letter} onMatch={onMatch} />
				))}
				{state === "empty" ? (
					<ColumnEmptyState>{t("sozluk.home.noTerms")}</ColumnEmptyState>
				) : state === "no-match" ? (
					<ColumnEmptyState>{sozlukPageEmptyLabel(t, letter)}</ColumnEmptyState>
				) : null}
			</div>
		</section>
	);
}

function ColumnEmptyState({children}: {children: React.ReactNode}) {
	return <p className="kp-sozluk-home__empty">{children}</p>;
}

function FilterableTermRow({
	node,
	letter,
	variant = "recent",
	rank,
	onMatch,
}: {
	node: ViewRef<"Term">;
	letter: string | undefined;
	variant?: "recent" | "popular";
	rank?: number;
	onMatch: (id: string, matched: boolean) => void;
}) {
	const data = useView(TermRowView, node);
	const title = data.title.toLowerCase();
	const matched = !letter || title.startsWith(letter);
	React.useEffect(() => onMatch(String(node.id), matched), [onMatch, node.id, matched]);
	if (!matched) return null;
	return <TermRow term={node} variant={variant} rank={rank} />;
}

function PopularColumn({connection, letter}: ColumnProps) {
	const t = useT();
	const [items] = useListView(TermConnectionView, connection);
	const {onMatch, state} = useFilteredColumn(items);

	return (
		<section>
			<header className="kp-sozluk-home__col-head">
				<span className="title">{t("sozluk.home.popular")}</span>
				<span>{t("sozluk.home.popularWindow")}</span>
			</header>
			<ol className="kp-sozluk-popular">
				{items.map(({node}, i) => (
					<FilterableTermRow
						key={node.id}
						node={node}
						letter={letter}
						variant="popular"
						rank={i + 1}
						onMatch={onMatch}
					/>
				))}
			</ol>
			{state === "empty" ? (
				<ColumnEmptyState>{t("sozluk.home.noTerms")}</ColumnEmptyState>
			) : state === "no-match" ? (
				<ColumnEmptyState>{sozlukPageEmptyLabel(t, letter)}</ColumnEmptyState>
			) : null}
		</section>
	);
}
