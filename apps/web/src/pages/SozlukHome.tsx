/**
 * Sözlük home page — fate. Two term connections (recent + popular) resolve in one
 * batched `useRequest({recentTerms, popularTerms})`; each maps to a fixed-sort
 * `list` root over the `terms` keyset (see `worker/features/fate/lists.ts`).
 * Letter + search filtering is client-side over the already-loaded first page.
 */
import * as React from "react";
import {useListView, useRequest, useView, type ViewRef} from "react-fate";
import {SozlukAlphabet} from "../components/sozluk/index";
import {TermRow, TermRowView} from "../components/sozluk/TermRow";
import {Screen} from "../fate/Screen";
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
	const totalsLine = status === "ok" ? "" : status === "loading" ? "yükleniyor…" : "yüklenemedi";

	return (
		<>
			<header className="kp-sozluk-home__masthead">
				<div>
					<h1 className="kp-sozluk-home__title">
						sözlük {totalsLine ? <small>{totalsLine}</small> : null}
					</h1>
				</div>
				<label className="kp-sozluk-home__searchbar">
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
				</label>
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

	return (
		<section>
			<header className="kp-sozluk-home__col-head">
				<span className="title">son eklenenler</span>
				<span>24 sa</span>
			</header>
			<div className="kp-sozluk-list">
				{items.map(({node}) => (
					<FilterableTermRow key={node.id} node={node} letter={letter} query={query} />
				))}
			</div>
		</section>
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
}: {
	node: ViewRef<"Term">;
	letter: string | undefined;
	query: string;
}) {
	const data = useView(TermRowView, node);
	const title = data.title.toLowerCase();
	if (letter && !title.startsWith(letter)) return null;
	if (query && !title.includes(query.toLowerCase())) return null;
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
