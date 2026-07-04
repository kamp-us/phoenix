/**
 * `ActorIdentity` — the shared moderation actor-row (ADR 0147). Renders an actor's
 * handle + karma-on-others through the same reusable `<Karma>` atom (#1208), with the
 * consuming surface's own CSS namespace + test-id prefix supplied as props. These
 * asserts pin the render contract every mod/admin surface reuses (divan's roster and
 * detail today via `CaylakIdentity`, the admin user-list #968 next).
 */
import {render, screen} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {ActorIdentity} from "./ActorIdentity";

describe("ActorIdentity — the shared actor row", () => {
	it("renders the resolved handle + karma with the surface's namespace", () => {
		render(
			<ActorIdentity
				authorId="a1"
				displayName="Ada Lovelace"
				username="ada"
				totalKarma={42}
				fallbackLabel="çaylak"
				identityClassName="kp-divan__identity"
				handleClassName="kp-divan__handle"
				karmaClassName="kp-divan__karma"
				karmaTestIdPrefix="divan-karma-"
			/>,
		);
		expect(screen.getByText("Ada Lovelace")).toBeTruthy();
		// the karma atom rides the surface's test-id prefix + the actor id
		const karma = screen.getByTestId("divan-karma-a1");
		expect(karma.textContent).toContain("42");
	});

	it("degrades to the fallback noun and hides karma when showKarma is false", () => {
		render(
			<ActorIdentity
				authorId="a2"
				displayName={null}
				username={null}
				totalKarma={0}
				fallbackLabel="çaylak"
				showKarma={false}
				karmaTestIdPrefix="divan-karma-"
			/>,
		);
		expect(screen.getByText("çaylak")).toBeTruthy();
		expect(screen.queryByTestId("divan-karma-a2")).toBeNull();
	});
});
