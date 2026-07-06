import type * as React from "react";
import {Link} from "react-router";
import {sozlukLetterHref} from "../../lib/sozlukLetterHref";
import {actorLabel} from "../moderation/actor-identity";
import "./Sozluk.css";

export type TermRow = {
	slug: string;
	title: string;
	count: number;
	excerpt?: string;
};

export function SozlukTermRow({term}: {term: TermRow}) {
	return (
		<Link to={`/sozluk/${term.slug}`} className="kp-sozluk-term-row">
			<div>
				<div className="kp-sozluk-term-row__title">{term.title}</div>
				{term.excerpt ? <div className="kp-sozluk-term-row__excerpt">{term.excerpt}</div> : null}
			</div>
			<span className="kp-sozluk-term-row__count">{term.count} tanım</span>
		</Link>
	);
}

export function SozlukTermList({terms}: {terms: TermRow[]}) {
	return (
		<div className="kp-sozluk-list">
			{terms.map((t) => (
				<SozlukTermRow key={t.slug} term={t} />
			))}
		</div>
	);
}

export type PopularTerm = {
	slug: string;
	title: string;
	totalScore: number;
};

export function SozlukPopular({terms}: {terms: PopularTerm[]}) {
	return (
		<ol className="kp-sozluk-popular">
			{terms.map((t, i) => (
				<li key={t.slug} className="kp-sozluk-popular__row">
					<span className="kp-sozluk-popular__rank">{String(i + 1).padStart(2, "0")}</span>
					<Link className="kp-sozluk-popular__title" to={`/sozluk/${t.slug}`}>
						{t.title}
					</Link>
					<span className="kp-sozluk-popular__meta">{t.totalScore} oy</span>
				</li>
			))}
		</ol>
	);
}

export type DefinitionData = {
	id: string;
	body: React.ReactNode;
	author: string;
	// Live identity (#2139): the current `{username, displayName}` so the label resolves
	// via `actorLabel` and the profile link targets the handle; both optional so an
	// unstamped caller falls back to the `author` snapshot.
	authorUsername?: string | null;
	authorDisplayName?: string | null;
	agoLabel: string;
	score: number;
};

export function SozlukDefinition({d}: {d: DefinitionData}) {
	const handle = d.authorUsername ?? d.author;
	return (
		<article className="kp-definition" id={d.id}>
			<div className="kp-definition__body kp-prose">{d.body}</div>
			<div className="kp-definition__meta">
				<Link to={`/u/${handle}`}>
					{actorLabel(d.authorDisplayName ?? null, d.authorUsername ?? null, d.author)}
				</Link>
				<span>·</span>
				<span>{d.agoLabel}</span>
				<span>·</span>
				<span>{d.score} oy</span>
			</div>
		</article>
	);
}

export function SozlukDefinitionList({defs}: {defs: DefinitionData[]}) {
	return (
		<div className="kp-sozluk-list">
			{defs.map((d) => (
				<SozlukDefinition key={d.id} d={d} />
			))}
		</div>
	);
}

const ALPHABET = [
	"a",
	"b",
	"c",
	"ç",
	"d",
	"e",
	"f",
	"g",
	"ğ",
	"h",
	"ı",
	"i",
	"j",
	"k",
	"l",
	"m",
	"n",
	"o",
	"ö",
	"p",
	"r",
	"s",
	"ş",
	"t",
	"u",
	"ü",
	"v",
	"y",
	"z",
];

/**
 * The A-Z index as real navigable links to `/sozluk?harf=<letter>` (issue #693):
 * each letter is a shareable URL, back-button-correct and middle-clickable. The
 * active letter links back to bare `/sozluk` so it still toggles its filter off.
 * Empty letters stay inert `<span>`s — no destination to navigate to.
 *
 * ARIA (#2169): the `<nav aria-label="Harf">` names the index as a landmark. Each
 * populated letter is a link whose accessible name spells out the letter ("A
 * harfi") — a bare "a" reads ambiguously to a screen reader that spells single
 * chars. Empty letters are inert spans (not announced as links) carrying a
 * visually-hidden "(… harfi, terim yok)" suffix, so an AT user hears the
 * populated/empty distinction the muted color conveys visually. The active letter
 * keeps `aria-current="page"`.
 */
export function SozlukAlphabet({
	value,
	emptyLetters = [],
}: {
	value?: string;
	emptyLetters?: string[];
}) {
	return (
		<nav className="kp-sozluk-alphabet" aria-label="Harf">
			{ALPHABET.map((l) => {
				const isEmpty = emptyLetters.includes(l);
				const isActive = value === l;
				const cls = [
					"kp-sozluk-alphabet__letter",
					isActive ? "is-active" : "",
					isEmpty ? "is-empty" : "",
				]
					.filter(Boolean)
					.join(" ");
				const letterName = `${l.toLocaleUpperCase("tr")} harfi`;
				if (isEmpty) {
					// Inert letter — a plain span (no interactive role) so it isn't announced as
					// a link. The visible glyph reads as the letter; a visually-hidden suffix
					// spells the name + "(terim yok)" so an AT user hears the empty distinction the
					// muted color conveys visually. (aria-label/aria-disabled aren't valid on a
					// generic span; the hidden text carries the semantics instead.)
					return (
						<span key={l} className={cls}>
							{l}
							<span className="kp-visually-hidden">{`(${letterName}, terim yok)`}</span>
						</span>
					);
				}
				return (
					<Link
						key={l}
						to={sozlukLetterHref(l, isActive)}
						className={cls}
						aria-label={letterName}
						aria-current={isActive ? "page" : undefined}
					>
						{l}
					</Link>
				);
			})}
		</nav>
	);
}
