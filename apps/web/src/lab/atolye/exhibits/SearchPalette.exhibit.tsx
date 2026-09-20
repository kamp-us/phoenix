import {type ComponentProps, useEffect, useMemo} from "react";
import {SearchPalette} from "../../../components/search/SearchPalette";
import {
	SearchPaletteProvider,
	useSearchPalette,
} from "../../../components/search/SearchPaletteState";
import {SEARCH_HISTORY_STORAGE_KEY} from "../../../components/search/searchHistory";
import {defineExhibit} from "../exhibit";

type HistoryState = "empty" | "recent";

function memoryStorage(history: HistoryState): Storage {
	const values = new Map<string, string>();
	if (history === "recent") {
		values.set(SEARCH_HISTORY_STORAGE_KEY, JSON.stringify(["effect", "react"]));
	}
	return {
		get length() {
			return values.size;
		},
		clear: () => values.clear(),
		getItem: (key) => values.get(key) ?? null,
		key: (index) => [...values.keys()][index] ?? null,
		removeItem: (key) => values.delete(key),
		setItem: (key, value) => values.set(key, value),
	};
}

function OpenSearchPalette({storage}: {storage: Storage}) {
	const {setOpen} = useSearchPalette();
	useEffect(() => setOpen(true), [setOpen]);
	return <SearchPalette storage={storage} />;
}

export function SearchPaletteExhibitDemo({history}: {history: HistoryState}) {
	const storage = useMemo(() => memoryStorage(history), [history]);
	return (
		<SearchPaletteProvider key={history}>
			<OpenSearchPalette storage={storage} />
		</SearchPaletteProvider>
	);
}

export const searchPaletteExhibit = defineExhibit<ComponentProps<typeof SearchPaletteExhibitDemo>>({
	id: "search-palette",
	title: "Search Palette",
	summary: "Gerçek arama paletinin sıfır sorgu ve yakın aramalar durumları.",
	component: SearchPaletteExhibitDemo,
	knobs: {
		history: {
			kind: "enum",
			label: "Arama geçmişi",
			default: "empty",
			options: [
				{value: "empty", label: "Boş"},
				{value: "recent", label: "Yakın aramalar"},
			],
		},
	},
});
