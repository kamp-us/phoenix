/**
 * Sözlük home page — fate. Two term connections (recent + popular) resolve in one
 * batched `useRequest({recentTerms, popularTerms})`; each maps to a fixed-sort
 * `list` root over the `terms` keyset (see `worker/features/sozluk/lists.ts`).
 * The masthead promotes a `+ yeni tanım` create CTA — the "go to a term" search half
 * folded into the global ⌘K `ara` (#2995, the #2412 single-search contract), so this
 * page carries no local search box. The alphabet's letter filter (`?harf=`) still
 * narrows the already-loaded first page client-side, so the filtered-to-zero copy names
 * that scope ("ilk sayfada"), never the whole corpus.
 */
import * as React from "react";
import {useListView, useRequest, useView, type ViewRef} from "react-fate";
import {useSearchParams} from "react-router";
import {SozlukAlphabet} from "../components/sozluk/index";
import {SozlukSubnavCta} from "../components/sozluk/SozlukSubnavCta";
import {TermRow, TermRowView} from "../components/sozluk/TermRow";
import {Screen} from "../fate/Screen";
import {PHOENIX_NAV_IA} from "../flags/keys";
import {useFlag} from "../flags/useFlag";
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

// The active letter is URL-driven (`/sozluk?harf=<letter>`, issue #693): the
// alphabet renders real links, so the filter is shareable + back-button-correct
// rather than transient component state.
export function SozlukHome() {
	const [params] = useSearchParams();
	const letter = params.get("harf") ?? undefined;
	// When `phoenix-nav-ia` is on, the persistent Subnav zone (App.tsx) owns the alphabet +
	// the `+ yeni tanım` CTA, so the masthead must not paint a second copy of either. Off ⇒
	// no zone, so the masthead hosts them itself. Same flag read the router gates the zone on;
	// `useFlag` is fate-free, safe here.
	const {value: inZone} = useFlag(PHOENIX_NAV_IA, false);

	return (
		<div className="kp-page">
			<div className="kp-page__inner">
				<Screen
					fallback={
						<SozlukHomeChrome letter={letter} inZone={inZone} status="loading">
							{null}
						</SozlukHomeChrome>
					}
					error={({code}) => (
						<SozlukHomeChrome
							letter={letter}
							inZone={inZone}
							status="error"
							errorMessage={code.toLowerCase()}
						>
							{null}
						</SozlukHomeChrome>
					)}
				>
					<SozlukHomeContent letter={letter} inZone={inZone} />
				</Screen>
			</div>
		</div>
	);
}

interface ContentProps {
	letter: string | undefined;
	// True when the persistent Subnav zone owns the alphabet + create CTA (#2602),
	// so this page must not paint a second copy of either.
	inZone: boolean;
}

function SozlukHomeContent({letter, inZone}: ContentProps) {
	const {recentTerms, popularTerms} = useRequest(homeRequest);

	return (
		<SozlukHomeChrome letter={letter} inZone={inZone} status="ok">
			<RecentColumn connection={recentTerms} letter={letter} />
			<PopularColumn connection={popularTerms} letter={letter} />
		</SozlukHomeChrome>
	);
}

interface ChromeProps extends ContentProps {
	status: "loading" | "ok" | "error";
	errorMessage?: string;
	children: React.ReactNode;
}

function SozlukHomeChrome({letter, inZone, status, errorMessage, children}: ChromeProps) {
	const totalsLine = status === "ok" ? "" : status === "loading" ? "yükleniyor…" : "yüklenemedi";

	return (
		<>
			<header className="kp-sozluk-home__masthead">
				<div>
					<h1 className="kp-sozluk-home__title">
						sözlük {totalsLine ? <small>{totalsLine}</small> : null}
					</h1>
				</div>
				{/* Flag on: the alphabet + create CTA live in the persistent Subnav zone (#2602),
				    so the masthead drops the CTA here to avoid a duplicate. Off ⇒ render it. */}
				{inZone ? null : <SozlukSubnavCta />}
			</header>

			{inZone ? null : <SozlukAlphabet value={letter} />}

			{status === "error" ? (
				<p style={{font: "var(--t-meta)", color: "var(--danger)", padding: "var(--s-3) 0"}}>
					sözlük yüklenemedi: {errorMessage}
				</p>
			) : null}

			<div className="kp-sozluk-home__columns">{children}</div>
		</>
	);
}

/**
 * Tracks which rows survive the client-side letter filter. Each row reads its own fate
 * view, so match state can only be reported up per-row via `onMatch`; this hook owns the
 * resulting map and derives the column's display state from it.
 *
 * - `empty` — the connection itself has zero terms (genuine-empty).
 * - `no-match` — terms exist but the letter filter excluded every loaded row.
 * - `ok` — at least one row is visible.
 */
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
	const [items] = useListView(TermConnectionView, connection);
	const {onMatch, state} = useFilteredColumn(items);

	return (
		<section>
			<header className="kp-sozluk-home__col-head">
				<span className="title">son eklenenler</span>
				<span>24 sa</span>
			</header>
			<div className="kp-sozluk-list">
				{items.map(({node}) => (
					<FilterableTermRow key={node.id} node={node} letter={letter} onMatch={onMatch} />
				))}
				{state === "empty" ? (
					<ColumnEmptyState>henüz terim yok.</ColumnEmptyState>
				) : state === "no-match" ? (
					<ColumnEmptyState>{sozlukPageEmptyLabel(letter)}</ColumnEmptyState>
				) : null}
			</div>
		</section>
	);
}

function ColumnEmptyState({children}: {children: React.ReactNode}) {
	return <p className="kp-sozluk-home__empty">{children}</p>;
}

/**
 * A column row that reads its own title and drops out of the DOM when the active
 * letter excludes it, with the filter colocated. Used by both columns so a letter
 * filters "son eklenenler" and "en çok oylananlar" alike.
 */
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
	const [items] = useListView(TermConnectionView, connection);
	const {onMatch, state} = useFilteredColumn(items);

	return (
		<section>
			<header className="kp-sozluk-home__col-head">
				<span className="title">en çok oylananlar</span>
				<span>tüm zamanlar</span>
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
				<ColumnEmptyState>henüz terim yok.</ColumnEmptyState>
			) : state === "no-match" ? (
				<ColumnEmptyState>{sozlukPageEmptyLabel(letter)}</ColumnEmptyState>
			) : null}
		</section>
	);
}
