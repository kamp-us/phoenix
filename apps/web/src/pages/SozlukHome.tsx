/**
 * Sözlük home page — fate. Two term connections (recent + popular) resolve in one
 * batched `useRequest({recentTerms, popularTerms})`; each maps to a fixed-sort
 * `list` root over the `terms` keyset (see `worker/features/fate/lists.ts`).
 * Letter + search filtering is client-side over the already-loaded first page.
 */
import * as React from "react";
import {useListView, useRequest, useView, type ViewRef} from "react-fate";
import {useNavigate} from "react-router";
import {SozlukAlphabet} from "../components/sozluk/index";
import {TermRow, TermRowView} from "../components/sozluk/TermRow";
import {Button} from "../components/ui/Button";
import {Screen} from "../fate/Screen";
import {slugifyTerm} from "../lib/slugifyTerm";
import "./SozlukHome.css";

/** A connection "view" is a plain `{items: {node: View}}` selection, not a `view<T>()`. */
const TermConnectionView = {items: {node: TermRowView}} as const;

const HOME_PAGE_SIZE = 5;

const homeRequest = {
	recentTerms: {list: TermConnectionView, args: {first: HOME_PAGE_SIZE}},
	popularTerms: {list: TermConnectionView, args: {first: HOME_PAGE_SIZE}},
} as const;

type TermConnection = ReturnType<typeof useRequest<typeof homeRequest>>["recentTerms"];

export function SozlukHome() {
	const [letter, setLetter] = React.useState<string | undefined>();
	const [query, setQuery] = React.useState("");

	return (
		<div className="kp-page">
			<div className="kp-page__inner">
				<Screen
					fallback={
						<SozlukHomeChrome
							letter={letter}
							query={query}
							setLetter={setLetter}
							setQuery={setQuery}
							status="loading"
						>
							{null}
						</SozlukHomeChrome>
					}
					error={({code}) => (
						<SozlukHomeChrome
							letter={letter}
							query={query}
							setLetter={setLetter}
							setQuery={setQuery}
							status="error"
							errorMessage={code.toLowerCase()}
						>
							{null}
						</SozlukHomeChrome>
					)}
				>
					<SozlukHomeContent
						letter={letter}
						query={query}
						setLetter={setLetter}
						setQuery={setQuery}
					/>
				</Screen>
			</div>
		</div>
	);
}

interface ContentProps {
	letter: string | undefined;
	query: string;
	setLetter: (l: string | undefined) => void;
	setQuery: (q: string) => void;
}

function SozlukHomeContent({letter, query, setLetter, setQuery}: ContentProps) {
	const {recentTerms, popularTerms} = useRequest(homeRequest);

	return (
		<SozlukHomeChrome
			letter={letter}
			query={query}
			setLetter={setLetter}
			setQuery={setQuery}
			status="ok"
		>
			<RecentColumn connection={recentTerms} letter={letter} query={query} />
			<PopularColumn connection={popularTerms} />
		</SozlukHomeChrome>
	);
}

interface ChromeProps extends ContentProps {
	status: "loading" | "ok" | "error";
	errorMessage?: string;
	children: React.ReactNode;
}

function SozlukHomeChrome({
	letter,
	query,
	setLetter,
	setQuery,
	status,
	errorMessage,
	children,
}: ChromeProps) {
	const navigate = useNavigate();
	const totalsLine = status === "ok" ? "" : status === "loading" ? "yükleniyor…" : "yüklenemedi";

	// Submitting the search routes to the existing fresh-slug composer branch at
	// `/sozluk/:slug` — no new creation backend (issue #97). Signed-in users land
	// on `NewTermComposer`; signed-out users get that page's unchanged 404/sign-in.
	function onSearchSubmit(e: React.FormEvent) {
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
				<form className="kp-sozluk-home__searchbar" onSubmit={onSearchSubmit}>
					<svg
						width="11"
						height="11"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2.4"
						aria-hidden="true"
					>
						<circle cx="11" cy="11" r="7" />
						<path d="m20 20-3.5-3.5" />
					</svg>
					<input
						value={query}
						onChange={(e) => setQuery(e.currentTarget.value)}
						placeholder="terim ara: race condition, idempotent…"
						aria-label="Terim ara"
					/>
				</form>
			</header>

			<SozlukAlphabet value={letter} onChange={setLetter} />

			{status === "error" ? (
				<p style={{font: "var(--t-meta)", color: "var(--danger)", padding: "var(--s-3) 0"}}>
					sözlük yüklenemedi: {errorMessage}
				</p>
			) : null}

			<div className="kp-sozluk-home__columns">{children}</div>
		</>
	);
}

interface RecentColumnProps {
	connection: TermConnection;
	letter: string | undefined;
	query: string;
}

function RecentColumn({connection, letter, query}: RecentColumnProps) {
	const [items] = useListView(TermConnectionView, connection);
	// Which rows survived the client-side letter/search filter. A non-empty `query`
	// with zero matches is the dead-end #97 fixes: offer to create the term instead.
	const [matches, setMatches] = React.useState<Record<string, boolean>>({});
	const onMatch = React.useCallback((id: string, matched: boolean) => {
		setMatches((prev) => (prev[id] === matched ? prev : {...prev, [id]: matched}));
	}, []);

	const hasMatch = items.some(({node}) => matches[String(node.id)]);
	const showCreateCta = query.trim().length > 0 && !hasMatch;

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
				{showCreateCta ? <CreateTermCta query={query} /> : null}
			</div>
		</section>
	);
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
 * A recent-column row that reads its own title and drops out of the DOM when the
 * active letter / search query excludes it, with the filter colocated.
 */
function FilterableTermRow({
	node,
	letter,
	query,
	onMatch,
}: {
	node: ViewRef<"Term">;
	letter: string | undefined;
	query: string;
	onMatch: (id: string, matched: boolean) => void;
}) {
	const data = useView(TermRowView, node);
	const title = data.title.toLowerCase();
	const matched =
		(!letter || title.startsWith(letter)) && (!query || title.includes(query.toLowerCase()));
	React.useEffect(() => onMatch(String(node.id), matched), [onMatch, node.id, matched]);
	if (!matched) return null;
	return <TermRow term={node} variant="recent" />;
}

interface PopularColumnProps {
	connection: TermConnection;
}

function PopularColumn({connection}: PopularColumnProps) {
	const [items] = useListView(TermConnectionView, connection);

	return (
		<section>
			<header className="kp-sozluk-home__col-head">
				<span className="title">en çok oylananlar</span>
				<span>tüm zamanlar</span>
			</header>
			<ol className="kp-sozluk-popular">
				{items.map(({node}, i) => (
					<TermRow key={node.id} term={node} variant="popular" rank={i + 1} />
				))}
			</ol>
		</section>
	);
}
