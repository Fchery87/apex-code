/** Typed facts prepared by a tool-owned permission spec and consumed by execution. */

export interface CanonicalPath {
	readonly kind: "canonical-path";
	readonly value: string;
}

export interface FileIdentity {
	readonly device: number;
	readonly inode: number;
}

export type PreparedPathOperation =
	| {
			readonly kind: "path-existing";
			readonly path: CanonicalPath;
			readonly identity: FileIdentity;
	  }
	| {
			readonly kind: "path-new";
			readonly path: CanonicalPath;
	  };

const preparedPathOperations = new WeakMap<object, PreparedPathOperation>();

export function setPreparedPathOperation(params: object, operation: PreparedPathOperation): void {
	preparedPathOperations.set(params, operation);
}

export function getPreparedPathOperation(params: object): PreparedPathOperation | undefined {
	return preparedPathOperations.get(params);
}
