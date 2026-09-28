import pkg from "../package.json" with {type: "json"};

// Derived from the manifest, never declared as a second literal that can drift from it.
export const VERSION = pkg.version;

/** The commit a source checkout runs, and whether its tracked files differ from that commit. */
export interface SourceReading {
	readonly sha: string;
	readonly dirty: boolean;
}

/**
 * What `fabrika --version` prints: the plain version for a published build, and the version plus
 * the commit for a source checkout, so a checkout running main is never read as the last release.
 * Only the display carries the suffix; {@link VERSION} stays plain for every semver comparison.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10099
 */
export const displayVersion = (version: string, reading: SourceReading | null): string =>
	reading === null ? version : `${version}+${reading.sha}${reading.dirty ? "-dirty" : ""} (source)`;
