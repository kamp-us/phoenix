/**
 * Sözlük home page. No local search box — that folded into the global ⌘K (#2995). No letter
 * filter either: a letter is its own page now (#9267), so a legacy `/sozluk?harf=X` link
 * redirects to `/sozluk/harf/X` instead of narrowing the two columns client-side.
 */
import type * as React from "react";
import {useListView, useRequest} from "react-fate";
import {Navigate, useSearchParams} from "react-router";
import {TermRow, TermRowView} from "../components/sozluk/TermRow";
import {Screen} from "../fate/Screen";
import {useT} from "../i18n";
import {sozlukLetterHref} from "../lib/sozlukLetterHref";
import {sozlukLetterParam} from "../lib/sozlukLetterParam";
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
	const [params] = useSearchParams();
	const harf = params.get("harf");
	const letter = sozlukLetterParam(harf ?? undefined);
	// A shared `?harf=` link predates the letter route, so it keeps working by landing on the
	// page it always meant. A `harf` naming no letter drops through to the home instead of
	// bouncing to a letter page that would be empty by construction.
	if (letter) return <Navigate to={sozlukLetterHref(letter, false)} replace />;

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
					<SozlukHomeContent />
				</Screen>
			</div>
		</div>
	);
}

function SozlukHomeContent() {
	const {recentTerms, popularTerms} = useRequest(homeRequest);

	return (
		<SozlukHomeChrome status="ok">
			<RecentColumn connection={recentTerms} />
			<PopularColumn connection={popularTerms} />
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

interface ColumnProps {
	connection: TermConnection;
}

function RecentColumn({connection}: ColumnProps) {
	const t = useT();
	const [items] = useListView(TermConnectionView, connection);

	return (
		<section>
			<header className="kp-sozluk-home__col-head">
				<span className="title">{t("sozluk.home.recent")}</span>
				<span>{t("sozluk.home.recentWindow")}</span>
			</header>
			<div className="kp-sozluk-list">
				{items.map(({node}) => (
					<TermRow key={node.id} term={node} variant="recent" />
				))}
				{items.length === 0 ? (
					<ColumnEmptyState>{t("sozluk.home.noTerms")}</ColumnEmptyState>
				) : null}
			</div>
		</section>
	);
}

function ColumnEmptyState({children}: {children: React.ReactNode}) {
	return <p className="kp-sozluk-home__empty">{children}</p>;
}

function PopularColumn({connection}: ColumnProps) {
	const t = useT();
	const [items] = useListView(TermConnectionView, connection);

	return (
		<section>
			<header className="kp-sozluk-home__col-head">
				<span className="title">{t("sozluk.home.popular")}</span>
				<span>{t("sozluk.home.popularWindow")}</span>
			</header>
			<ol className="kp-sozluk-popular">
				{items.map(({node}, i) => (
					<TermRow key={node.id} term={node} variant="popular" rank={i + 1} />
				))}
			</ol>
			{items.length === 0 ? <ColumnEmptyState>{t("sozluk.home.noTerms")}</ColumnEmptyState> : null}
		</section>
	);
}
