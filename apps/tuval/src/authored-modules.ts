/**
 * The author's own modules as one config load read them: the source text Node compiled each stamped
 * file from, and the files each imports by path (`./module-generations.ts` records both). A reload
 * reads it to tell which files a program row's code stands on, so an edit confined to a helper the
 * row's functions call still moves that row (#9822).
 *
 * A row does not carry the module that built it, and a factory row (`logProgram({write})`) is not
 * any module's export, so a row's files are found through its functions instead: a function's text
 * is a slice of the source it was compiled from, which names the file that defined it.
 */

/**
 * Whether `text` is the slice of `source` starting at `at`, up to the characters type stripping
 * blanked. Node strips a `.ts` file's types by replacing them with whitespace, so a function's text
 * holds a space everywhere the file holds a type, and its every other character sits at the same
 * offset (https://nodejs.org/api/typescript.html#type-stripping).
 */
const sliceAt = (text: string, source: string, at: number): boolean => {
	if (at + text.length > source.length) return false;
	for (let index = 0; index < text.length; index += 1) {
		const char = text.charAt(index);
		if (char !== source.charAt(at + index) && char.trim() !== "") return false;
	}
	return true;
};

/** Whether `source` is where a function whose text is `text` was compiled from. */
const defines = (source: string, text: string): boolean => {
	// Stripping only blanks, so the text's leading run of non-blank characters is in the file as is.
	const head = /^\S+/.exec(text)?.[0];
	if (head === undefined) return false;
	for (let at = source.indexOf(head); at !== -1; at = source.indexOf(head, at + 1)) {
		if (sliceAt(text, source, at)) return true;
	}
	return false;
};

export class AuthoredModules {
	/** A kernel started from rows rather than a config: no author file stands behind any row. */
	static readonly none = new AuthoredModules(new Map(), new Map());

	/** Each stamped file's path, beside the source text Node compiled it from. */
	private readonly sources: ReadonlyMap<string, string>;
	/** Each stamped file's path, beside the stamped files it imports by path. */
	private readonly imports: ReadonlyMap<string, ReadonlySet<string>>;
	private readonly definingCache = new Map<string, ReadonlyArray<string>>();

	constructor(
		sources: ReadonlyMap<string, string>,
		imports: ReadonlyMap<string, ReadonlySet<string>>,
	) {
		this.sources = sources;
		this.imports = imports;
	}

	/**
	 * These modules beside `other`'s, as a desk running several loads at once holds them: the desk's
	 * load and each project opened after it (#9685). A file both loads read keeps `other`'s source,
	 * the later read.
	 */
	union(other: AuthoredModules): AuthoredModules {
		if (other.sources.size === 0) return this;
		if (this.sources.size === 0) return other;
		const imports = new Map<string, ReadonlySet<string>>(this.imports);
		for (const [file, imported] of other.imports) {
			imports.set(file, new Set([...(imports.get(file) ?? []), ...imported]));
		}
		return new AuthoredModules(new Map([...this.sources, ...other.sources]), imports);
	}

	/**
	 * The files a function whose text is `text` could have been compiled from. A short text can sit
	 * in several files, and every one of them is answered. A package's function sits in none: the
	 * desk holds one copy of a package, which only a restart replaces.
	 */
	definingFiles(text: string): ReadonlyArray<string> {
		const cached = this.definingCache.get(text);
		if (cached !== undefined) return cached;
		const files = [...this.sources]
			.filter(([, source]) => defines(source, text))
			.map(([path]) => path);
		this.definingCache.set(text, files);
		return files;
	}

	/** `roots` and every stamped file they import by path, transitively, sorted. */
	closure(roots: Iterable<string>): ReadonlyArray<string> {
		const reached = new Set<string>();
		const walk = (file: string): void => {
			if (reached.has(file)) return;
			reached.add(file);
			for (const imported of this.imports.get(file) ?? []) walk(imported);
		};
		for (const root of roots) walk(root);
		return [...reached].sort();
	}

	/**
	 * The source text behind functions whose texts are `texts`: every file that defines one of them,
	 * and every file those import by path, each beside its path. Two loads answer the same text for a
	 * row exactly when no file its code stands on was edited between them.
	 */
	sourceBehind(texts: Iterable<string>): string {
		const roots = new Set<string>();
		for (const text of texts) for (const file of this.definingFiles(text)) roots.add(file);
		return this.closure(roots)
			.map((file) => `${file}(${this.sources.get(file) ?? ""})`)
			.join();
	}
}
