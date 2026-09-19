/**
 * kamp.us's one search surface (ADR 0186): the ⌘K palette over the global search contract.
 *
 * It mounts under `FateProvider` because it reads `searchTerms`/`searchPosts`, while its
 * trigger lives in the fate-free `Topbar` — the two agree through the hoisted open state in
 * `SearchPaletteState`. Selecting a row navigates; Enter on the trailing row (or on no row at
 * all) falls through to the results page, which owns depth and pagination.
 */
import {CommandPalette, type CommandPaletteItem, Kbd} from "@kampus/design";
import {BookOpen, FileText, Search} from "lucide-react";
import {useEffect, useMemo, useState} from "react";
import {useLocation, useNavigate} from "react-router";
import {useT, useTPlural} from "../../i18n";
import {MIN_SEARCH_LENGTH, searchTarget} from "../../lib/searchTarget";
import {Icon} from "../Icon";
import {useSearchPalette} from "./SearchPaletteState";
import {PANO_SIGIL, SOZLUK_SIGIL, useSearchResults} from "./useSearchResults";

/** The trailing row's value. Namespaced like every other row so no result can collide. */
const ALL_RESULTS = "all-results";

export function SearchPalette() {
	const {open, setOpen} = useSearchPalette();
	const navigate = useNavigate();
	const location = useLocation();
	const t = useT();
	const tp = useTPlural();
	const [query, setQuery] = useState("");
	const [scope, setScope] = useState<string | undefined>(undefined);
	const results = useSearchResults(query, scope);

	// Opening on the results page carries that page's query in, so ⌘K refines the search a
	// reader already ran instead of making them retype it. Closing clears it: a palette that
	// reopens holding a stale query answers a question nobody asked.
	const urlQuery =
		location.pathname === "/search" ? (new URLSearchParams(location.search).get("q") ?? "") : "";
	useEffect(() => {
		setQuery(open ? urlQuery : "");
		// `urlQuery` is deliberately not a dependency: it seeds the field at the open seam and
		// must not overwrite what the reader has typed since.
	}, [open]);

	const scopes = useMemo(
		() => [
			{sigil: SOZLUK_SIGIL, label: t("search.palette.scope.sozluk")},
			{sigil: PANO_SIGIL, label: t("search.palette.scope.pano")},
		],
		[t],
	);

	const items = useMemo<readonly CommandPaletteItem[]>(() => {
		const rows: CommandPaletteItem[] = [];
		if (results.status === "ok") {
			for (const term of results.terms) {
				rows.push({
					value: `term:${term.id}`,
					label: term.title,
					description: tp(term.definitionCount, {
						one: "sozluk.entryCount.one",
						other: "sozluk.entryCount.other",
					}),
					group: t("search.sozluk"),
					icon: <Icon icon={BookOpen} size={20} />,
					scope: SOZLUK_SIGIL,
				});
			}
			for (const post of results.posts) {
				rows.push({
					value: `post:${post.id}`,
					label: post.title,
					...(post.host ? {description: post.host} : {}),
					group: t("search.pano"),
					icon: <Icon icon={FileText} size={20} />,
					scope: PANO_SIGIL,
				});
			}
		}
		// The way out of a palette that is only ever a first page: the same query, on the page
		// that paginates it. Offered whenever the query is long enough to have a results page.
		if (searchTarget(query) !== null) {
			rows.push({
				value: ALL_RESULTS,
				label: t("search.palette.allResults", {query: query.trim()}),
				icon: <Icon icon={Search} size={20} />,
			});
		}
		return rows;
	}, [results, query, t, tp]);

	const status =
		results.status === "error"
			? t("search.failed", {code: "hata"})
			: query.trim().length < MIN_SEARCH_LENGTH
				? t("search.minLength", {min: MIN_SEARCH_LENGTH})
				: t("search.palette.empty");

	const select = (item: CommandPaletteItem) => {
		if (item.value === ALL_RESULTS) {
			const target = searchTarget(query);
			if (target) navigate(target);
			return;
		}
		const [kind, ...rest] = item.value.split(":");
		const id = rest.join(":");
		const row =
			results.status === "ok"
				? kind === "term"
					? results.terms.find((term) => term.id === id)
					: results.posts.find((post) => post.id === id)
				: undefined;
		if (!row) return;
		navigate(kind === "term" ? `/sozluk/${row.slug}` : `/pano/${row.slug ?? row.id}`);
	};

	return (
		<CommandPalette
			open={open}
			onOpenChange={setOpen}
			// The shortcut is the Topbar's: it owns ⌘K for the whole shell, including the frames
			// where this palette is not yet mounted (the session has not settled).
			shortcut={false}
			title={t("search.palette.title")}
			placeholder={t("search.palette.placeholder")}
			emptyLabel={status}
			loadingLabel={t("search.searching")}
			loading={results.status === "loading"}
			query={query}
			onQueryChange={setQuery}
			// The backend ranks and narrows; re-filtering here would drop server matches whose
			// text does not literally contain the query (ADR 0080's FTS is not a substring test).
			filter={() => true}
			items={items}
			scopes={scopes}
			scopeHintLabel={t("search.palette.scopeHint")}
			onScopeChange={setScope}
			onSelect={select}
			footer={
				<>
					<Kbd>↑↓</Kbd> {t("search.palette.legend.move")} · <Kbd>↵</Kbd>{" "}
					{t("search.palette.legend.open")} · <Kbd>esc</Kbd> {t("search.palette.legend.close")}
				</>
			}
		/>
	);
}
