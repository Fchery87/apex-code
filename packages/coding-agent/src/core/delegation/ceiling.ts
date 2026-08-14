/**
 * The capability ceiling (roadmap Phase 5, ADR 0008, contracts.md §1.1 invariant 4).
 * A pure function over capability sets: no knowledge of tools, sessions, or agent
 * definitions. A delegated child's requested capability set must be a subset of its
 * parent's, with `exec` expanded to the full set first -- a subprocess a parent can
 * spawn can reach every other capability, so a parent holding `exec` is treated as
 * holding everything for ceiling purposes (contracts.md §1.1's escalation rule).
 *
 * Refuses rather than narrows on a partial match: a request outside the ceiling names
 * the offending capability and stops, instead of silently admitting the child with
 * less than it asked for. A silently narrowed child produces work that looks complete
 * and is not, which is worse than a refusal the caller can read and route around.
 */

import { ALL_CAPABILITIES, type Capability } from "../tools/contract.ts";

export type CapabilityCeilingResult =
	| { allowed: true; capabilities: ReadonlySet<Capability> }
	| { allowed: false; deniedCapability: Capability };

/** `exec` implies every other capability (contracts.md §1.1); every other capability stands alone. */
function expandCapabilities(capabilities: ReadonlySet<Capability>): ReadonlySet<Capability> {
	return capabilities.has("exec") ? ALL_CAPABILITIES : capabilities;
}

/**
 * Admits the exact `requested` set when every capability in it is covered by the
 * (possibly exec-expanded) `parent` set. The admitted set is the request, not the
 * expanded parent -- a child is granted what its own tools need, not everything its
 * parent could theoretically reach.
 */
export function computeCapabilityCeiling(
	parent: ReadonlySet<Capability>,
	requested: ReadonlySet<Capability>,
): CapabilityCeilingResult {
	const expandedParent = expandCapabilities(parent);
	for (const capability of requested) {
		if (!expandedParent.has(capability)) {
			return { allowed: false, deniedCapability: capability };
		}
	}
	return { allowed: true, capabilities: requested };
}
