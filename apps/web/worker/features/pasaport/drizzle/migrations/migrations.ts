import m0000 from "./0000_kind_squadron_supreme.sql";
import m0001 from "./0001_stale_pretty_boy.sql";
import journal from "./meta/_journal.json";

const migrations: {
	journal: typeof journal;
	migrations: Record<string, string>;
} = {
	journal,
	migrations: {
		m0000,
		m0001,
	},
};

export default migrations;
