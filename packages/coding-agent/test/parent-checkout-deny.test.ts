import { type Static, Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createPathPermissionSpec } from "../src/core/tools/path-permission.ts";

const schema = Type.Object({ path: Type.String() });
type Params = Static<typeof schema>;

describe("parent checkout deny", () => {
	it("denies a path inside the parent and allows a path in the worktree", () => {
		const spec = createPathPermissionSpec<typeof schema>({
			cwd: "/repo/.apex-code/worktrees/feature",
			defaultBehavior: "ask",
			verb: "Edit",
			getPath: (params: Params) => params.path,
			denyInside: "/repo",
		});
		expect(spec.defaultBehaviorFor?.({ path: "/repo/src/main.ts" })).toBe("deny");
		expect(spec.defaultBehaviorFor?.({ path: "/repo/.apex-code/worktrees/feature/src/main.ts" })).toBeUndefined();
	});
});
