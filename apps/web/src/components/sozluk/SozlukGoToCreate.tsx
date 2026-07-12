import type * as React from "react";
import {useNavigate} from "react-router";
import {slugifyTerm} from "../../lib/slugifyTerm";

/**
 * The sözlük go-to-or-create box, extracted so the flag-off masthead (SozlukHome) and
 * the flag-on persistent Subnav zone (SozlukSubnavLayout) render the identical control.
 * Go-to-or-create, NOT search (#1669): on Enter it routes the typed term to the
 * fresh-slug composer branch at `/sozluk/:slug` (create dead-end handled there, issue
 * #97) — deliberately distinct from the topbar's federated `ara`, marked by the
 * accent `+` glyph rather than a magnifier. `className` is the only surface that
 * differs between the two hosts (the masthead's `kp-sozluk-home__searchbar` box vs the
 * Subnav's `kp-subnav__input` taxonomy slot); the markup + submit behavior are one.
 */
export function SozlukGoToCreate({
	className,
	query,
	setQuery,
}: {
	className: string;
	query: string;
	setQuery: (q: string) => void;
}) {
	const navigate = useNavigate();
	function onGoToOrCreate(e: React.SyntheticEvent) {
		e.preventDefault();
		const slug = slugifyTerm(query);
		if (slug) navigate(`/sozluk/${slug}`);
	}
	return (
		<form className={className} onSubmit={onGoToOrCreate}>
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
	);
}
