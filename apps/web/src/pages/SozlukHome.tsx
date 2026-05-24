/**
 * Sozluk home page.
 *
 * Idiomatic Relay shape: a single `useLazyLoadQuery` spreads two
 * `@connection`-keyed fragments on `Query` — one per column (`recent` and
 * `popular`). Each fragment selects the same `terms(...)` field with a
 * different `sort` arg; `@connection(filters: ["sort"])` keys them
 * separately in the store. No `@refetchable` — the home ships first-page
 * only; the connection shape is future-proofed.
 *
 * Each column iterates `edges → TermRow` and hands the node fragment ref
 * to the row component (`TermRowFragment on Term`). The row component
 * stays oblivious to which column it lives in.
 *
 * No mutations from this page; no live updates (sozluk home isn't a live
 * surface).
 */
import * as React from "react";
import {graphql, useFragment, useLazyLoadQuery} from "react-relay";
import type {SozlukHomePopularFragment$key} from "../__generated__/SozlukHomePopularFragment.graphql";
import type {SozlukHomeQuery} from "../__generated__/SozlukHomeQuery.graphql";
import type {SozlukHomeRecentFragment$key} from "../__generated__/SozlukHomeRecentFragment.graphql";
import {SozlukAlphabet} from "../components/sozluk/index";
import {TermRow} from "../components/sozluk/TermRow";
import {QueryBoundary} from "../relay/QueryBoundary";
import "./SozlukHome.css";

const HomeQuery = graphql`
	query SozlukHomeQuery {
		__id
		...SozlukHomeRecentFragment
		...SozlukHomePopularFragment
	}
`;

/**
 * `SozlukHome__recentTerms` connection on `Query`. Keyed by `sort` so it
 * shares no store entries with the popular column even though both read
 * `terms(...)`. No `@refetchable` — first-page only on the home; pagination
 * lands on a follow-up.
 *
 * Aliased as `recentTerms` (and key suffixed `__recentTerms`) because Relay
 * forbids two fragments composed onto the same parent (`Query`) selecting
 * the same field with different argument values, and `@connection` enforces
 * `<key>__<fieldName>` for its store key invariant. AC text said
 * `SozlukHome_terms_recent`, but the alias-based shape is the only valid
 * Relay form here.
 */
const SozlukHomeRecentFragmentDef = graphql`
	fragment SozlukHomeRecentFragment on Query
	@argumentDefinitions(first: {type: "Int", defaultValue: 5}) {
		recentTerms: terms(sort: recent, first: $first)
			@connection(key: "SozlukHome__recentTerms", filters: ["sort"]) {
			edges {
				node {
					id
					# title duplicated at the parent so the alphabet and
					# search client-side filter can read it without unmasking
					# the row fragment (the row declares its own copy via
					# TermRowFragment). Mirrors PanoFeed's tag pattern.
					title
					...TermRowFragment
				}
			}
			pageInfo {
				hasNextPage
				endCursor
			}
			totalCount
		}
	}
`;

/**
 * `SozlukHome__popularTerms` connection on `Query`. Same shape as the
 * recent fragment with a different sort arg + connection key.
 */
const SozlukHomePopularFragmentDef = graphql`
	fragment SozlukHomePopularFragment on Query
	@argumentDefinitions(first: {type: "Int", defaultValue: 5}) {
		popularTerms: terms(sort: popular, first: $first)
			@connection(key: "SozlukHome__popularTerms", filters: ["sort"]) {
			edges {
				node {
					id
					...TermRowFragment
				}
			}
			pageInfo {
				hasNextPage
				endCursor
			}
			totalCount
		}
	}
`;

export function SozlukHome() {
	const [letter, setLetter] = React.useState<string | undefined>();
	const [query, setQuery] = React.useState("");

	return (
		<div className="kp-page">
			<div className="kp-page__inner">
				<QueryBoundary
					loading={
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
					error={(err) => (
						<SozlukHomeChrome
							letter={letter}
							query={query}
							setLetter={setLetter}
							setQuery={setQuery}
							status="error"
							errorMessage={err.message}
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
				</QueryBoundary>
			</div>
		</div>
	);
}

interface ContentProps {
	letter: string | undefined;
	query: string;
	setLetter: (l: string) => void;
	setQuery: (q: string) => void;
}

function SozlukHomeContent({letter, query, setLetter, setQuery}: ContentProps) {
	const data = useLazyLoadQuery<SozlukHomeQuery>(HomeQuery, {});

	return (
		<SozlukHomeChrome
			letter={letter}
			query={query}
			setLetter={setLetter}
			setQuery={setQuery}
			status="ok"
		>
			<RecentColumn fragmentRef={data} letter={letter} query={query} />
			<PopularColumn fragmentRef={data} />
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
	fragmentRef: SozlukHomeRecentFragment$key;
	letter: string | undefined;
	query: string;
}

function RecentColumn({fragmentRef, letter, query}: RecentColumnProps) {
	const data = useFragment(SozlukHomeRecentFragmentDef, fragmentRef);
	const edges = data.recentTerms.edges;
	const filtered = edges.filter((edge) => {
		const node = edge.node;
		if (letter && !node.title.toLowerCase().startsWith(letter)) return false;
		if (query && !node.title.toLowerCase().includes(query.toLowerCase())) return false;
		return true;
	});

	return (
		<section>
			<header className="kp-sozluk-home__col-head">
				<span className="title">son eklenenler</span>
				<span>24 sa</span>
			</header>
			<div className="kp-sozluk-list">
				{filtered.map((edge) => (
					<TermRow key={edge.node.id} term={edge.node} variant="recent" />
				))}
			</div>
		</section>
	);
}

interface PopularColumnProps {
	fragmentRef: SozlukHomePopularFragment$key;
}

function PopularColumn({fragmentRef}: PopularColumnProps) {
	const data = useFragment(SozlukHomePopularFragmentDef, fragmentRef);
	const edges = data.popularTerms.edges;

	return (
		<section>
			<header className="kp-sozluk-home__col-head">
				<span className="title">en çok oylananlar</span>
				<span>tüm zamanlar</span>
			</header>
			<ol className="kp-sozluk-popular">
				{edges.map((edge, i) => (
					<TermRow key={edge.node.id} term={edge.node} variant="popular" rank={i + 1} />
				))}
			</ol>
		</section>
	);
}
