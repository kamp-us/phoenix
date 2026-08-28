export interface SourceManifest {
	readonly path: string;
	readonly name: string;
	readonly version: string;
	readonly private: boolean;
}

/** Turn a network Git remote into a credential-free, portable HTTPS origin. */
export const canonicalOriginUrl = (value: string): string | null => {
	const input = value.trim();
	if (input === "") return null;
	const scp = input.includes("://") ? null : /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(input);
	if (scp !== null) {
		const host = scp[1];
		const repoPath = scp[2]?.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
		return host === undefined || repoPath === undefined || !repoPath.includes("/")
			? null
			: `https://${host}/${repoPath}`;
	}
	try {
		const url = new URL(input);
		if (!["http:", "https:", "ssh:", "git:"].includes(url.protocol)) return null;
		const repoPath = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
		return url.hostname === "" || !repoPath.includes("/")
			? null
			: `https://${url.hostname}/${repoPath}`;
	} catch {
		return null;
	}
};

export const parseSourceManifest = (path: string, text: string): SourceManifest | null => {
	try {
		const value = JSON.parse(text) as Record<string, unknown>;
		return typeof value.name === "string" &&
			value.name !== "" &&
			typeof value.version === "string" &&
			value.version !== ""
			? {path, name: value.name, version: value.version, private: value.private === true}
			: null;
	} catch {
		return null;
	}
};
