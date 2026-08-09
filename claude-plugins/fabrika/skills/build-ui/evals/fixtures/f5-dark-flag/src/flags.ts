// Server-evaluated release flags. There is NO local override mechanism:
// a flag's value comes from the remote flag service, and the dev harness
// has no credentials for it in this environment.
export const flags = {
	"member-rooms": false, // dark: the /rooms route 404s while false
};
