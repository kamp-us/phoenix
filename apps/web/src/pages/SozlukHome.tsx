/**
 * Sözlük home page — fate. Two term connections (recent + popular) resolve in one
 * batched `useRequest({recentTerms, popularTerms})`; each maps to a fixed-sort
 * `list` root over the `terms` keyset (see `worker/features/sozluk/lists.ts`).
 * The masthead box is a go-to-or-create affordance (`/sozluk/:slug`), NOT search —
 * kept lexically + visually distinct from the topbar's federated `ara` (#1669). Its
 * as-you-type letter/query filtering is client-side over the already-loaded first page,
 * so the filtered-to-zero copy names that scope ("ilk sayfada"), never the whole corpus.
 */
import * as React from "react";
import {useListView, useRequest, useView, type ViewRef} from "react-fate";
import {useNavigate, useSearchParams} from "react-router";
import {SozlukAlphabet} from "../components/sozluk/index";
import {TermRow, TermRowView} from "../components/sozluk/TermRow";
import {Button} from "../components/ui/Button";
import {Screen} from "../fate/Screen";
import {slugifyTerm} from "../lib/slugifyTerm";
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
	const [query, setQuery] = React.useState("");

	return (
		<div className="kp-page">
			<div className="kp-page__inner">
				<Screen
					fallback={
						<SozlukHomeChrome letter={letter} query={query} setQuery={setQuery} status="loading">
							{null}
						</SozlukHomeChrome>
					}
					error={({code}) => (
						<SozlukHomeChrome
							letter={letter}
							query={query}
							setQuery={setQuery}
							status="error"
							errorMessage={code.toLowerCase()}
						>
							{null}
						</SozlukHomeChrome>
					)}
				>
					<SozlukHomeContent letter={letter} query={query} setQuery={setQuery} />
				</Screen>
			</div>
		</div>
	);
}

interface ContentProps {
	letter: string | undefined;
	query: string;
	setQuery: (q: string) => void;
}

function SozlukHomeContent({letter, query, setQuery}: ContentProps) {
	const {recentTerms, popularTerms} = useRequest(homeRequest);

	return (
		<SozlukHomeChrome letter={letter} query={query} setQuery={setQuery} status="ok">
			<RecentColumn connection={recentTerms} letter={letter} query={query} />
			<PopularColumn connection={popularTerms} letter={letter} query={query} />
		</SozlukHomeChrome>
	);
}

interface ChromeProps extends ContentProps {
	status: "loading" | "ok" | "error";
	errorMessage?: string;
	children: React.ReactNode;
}

function SozlukHomeChrome({letter, query, setQuery, status, errorMessage, children}: ChromeProps) {
	const navigate = useNavigate();
	const totalsLine = status === "ok" ? "" : status === "loading" ? "yükleniyor…" : "yüklenemedi";

	// Go-to-or-create, NOT search (#1669). Deliberately distinct from the topbar's
	// federated `ara` (icon+"ara" = ranked `/search?q=` site-wide): on Enter this routes
	// the typed term to the fresh-slug composer branch at `/sozluk/:slug` — no new creation
	// backend (issue #97). Signed-in users land on `NewTermComposer`; signed-out users get
	// that page's unchanged 404/sign-in.
	function onGoToOrCreate(e: React.SyntheticEvent) {
		e.preventDefault();
		const slug = slugifyTerm(query);
		if (slug) navigate(`/sozluk/${slug}`);
	}

	return (
		<>
			<header className="kp-sozluk-home__masthead">
				<div>
					<h1 className="kp-sozluk-home__title">
						sözlük {totalsLine ? <small>{totalsLine}</small> : null}
					</h1>
				</div>
				<form
					className="kp-sozluk-home__searchbar kp-sozluk-home__gotocreate"
					onSubmit={onGoToOrCreate}
				>
					<svg
						width="11"
						height="11"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2.4"
						aria-hidden="true"
					>
						<path d="M12 5v14M5 12h14" />
					</svg>
					<input
						value={query}
						onChange={(e) => setQuery(e.currentTarget.value)}
						placeholder="terime git ya da oluştur: race condition, idempotent…"
						aria-label="Terime git ya da oluştur"
					/>
				</form>
			</header>

			<SozlukAlphabet value={letter} />

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
 * Tracks which rows survive the client-side letter/search filter. Each row reads its
 * own fate view, so match state can only be reported up per-row via `onMatch`; this
 * hook owns the resulting map and derives the column's display state from it.
 *
 * - `empty` — the connection itself has zero terms (genuine-empty).
 * - `no-match` — terms exist but a letter/search filter excluded every loaded row.
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
	query: string;
}

function RecentColumn({connection, letter, query}: ColumnProps) {
	const [items] = useListView(TermConnectionView, connection);
	const {onMatch, state} = useFilteredColumn(items);
	// A non-empty `query` that matches nothing is the create dead-end #97 fixes: the
	// filtered-to-zero empty state offers to create the typed term instead of going blank.
	const showCreateCta = query.trim().length > 0;

	return (
		<section>
			<header className="kp-sozluk-home__col-head">
				<span className="title">son eklenenler</span>
				<span>24 sa</span>
			</header>
			<div className="kp-sozluk-list">
				{items.map(({node}) => (
					<FilterableTermRow
						key={node.id}
						node={node}
						letter={letter}
						query={query}
						onMatch={onMatch}
					/>
				))}
				{state === "empty" ? (
					<ColumnEmptyState>henüz terim yok.</ColumnEmptyState>
				) : state === "no-match" ? (
					showCreateCta ? (
						<CreateTermCta query={query} />
					) : (
						<ColumnEmptyState>{sozlukPageEmptyLabel(letter, query)}</ColumnEmptyState>
					)
				) : null}
			</div>
		</section>
	);
}

function ColumnEmptyState({children}: {children: React.ReactNode}) {
	return <p className="kp-sozluk-home__empty">{children}</p>;
}

/**
 * No-match call-to-action: routes the typed query to the existing fresh-slug
 * composer at `/sozluk/:slug` (issue #97). Shown when a search yields no term, so
 * a zero-match query is a create path, not a silent dead-end.
 */
function CreateTermCta({query}: {query: string}) {
	const navigate = useNavigate();
	const slug = slugifyTerm(query);
	if (!slug) return null;
	return (
		<div className="kp-sozluk-home__create-cta">
			<p>"{query.trim()}" diye bir terim yok.</p>
			<Button variant="primary" size="sm" onClick={() => navigate(`/sozluk/${slug}`)}>
				"{query.trim()}" terimini oluştur
			</Button>
		</div>
	);
}

/**
 * A column row that reads its own title and drops out of the DOM when the active
 * letter / search query excludes it, with the filter colocated. Used by both columns
 * so a letter/search filters "son eklenenler" and "en çok oylananlar" alike.
 */
function FilterableTermRow({
	node,
	letter,
	query,
	variant = "recent",
	rank,
	onMatch,
}: {
	node: ViewRef<"Term">;
	letter: string | undefined;
	query: string;
	variant?: "recent" | "popular";
	rank?: number;
	onMatch: (id: string, matched: boolean) => void;
}) {
	const data = useView(TermRowView, node);
	const title = data.title.toLowerCase();
	const matched =
		(!letter || title.startsWith(letter)) && (!query || title.includes(query.toLowerCase()));
	React.useEffect(() => onMatch(String(node.id), matched), [onMatch, node.id, matched]);
	if (!matched) return null;
	return <TermRow term={node} variant={variant} rank={rank} />;
}

function PopularColumn({connection, letter, query}: ColumnProps) {
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
						query={query}
						variant="popular"
						rank={i + 1}
						onMatch={onMatch}
					/>
				))}
			</ol>
			{state === "empty" ? (
				<ColumnEmptyState>henüz terim yok.</ColumnEmptyState>
			) : state === "no-match" ? (
				<ColumnEmptyState>{sozlukPageEmptyLabel(letter, query)}</ColumnEmptyState>
			) : null}
		</section>
	);
}
