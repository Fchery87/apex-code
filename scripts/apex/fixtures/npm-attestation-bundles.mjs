/**
 * Offline fixture reproducing the *raw* attestation-bundle objects npm 11.19.0
 * exposes in `npm audit signatures --json --include-attestations`.
 *
 * Verified by reading the pinned installed npm, not by guessing:
 *
 *   node_modules/pacote/lib/registry.js
 *     const { attestations } = await res.json()          // registry response
 *     const bundles = attestations.map(({ predicateType, bundle }) => {
 *       const statement = JSON.parse(
 *         Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString('utf8'))
 *       const keyid = bundle.dsseEnvelope.signatures[0].keyid
 *       ...
 *     })
 *     mani._attestationBundles = attestations           // <- the RAW array
 *
 *   lib/utils/verify-signatures.js
 *     attestationBundles: _attestationBundles           // -> verified[].attestationBundles
 *     result = { invalid, missing }; result.verified = this.verified
 *
 * The decoded `statement` is pacote's own local variable. It is never attached
 * to the objects npm serialises, so an `attestationBundles[].statement` field
 * cannot appear in real output. Only `bundle.dsseEnvelope.payload` (base64
 * in-toto statement) is present, which is what this fixture models.
 *
 * Real releases also carry a second, keyed publish attestation alongside the
 * keyless SLSA provenance one, so the fixture emits both: selecting the SLSA
 * entry by predicateType is part of what the verifier has to get right.
 */

export const SLSA_PROVENANCE_PREDICATE_TYPE = "https://slsa.dev/provenance/v1";
export const NPM_PUBLISH_PREDICATE_TYPE = "https://github.com/npm/attestation/tree/main/specs/publish/v0.1";

/** The in-toto statement GitHub's provenance generator signs for an npm publish. */
export function buildProvenanceStatement({ subjectName, subjectSha512, repository, workflowPath, workflowRef, gitCommit }) {
	return {
		_type: "https://in-toto.io/Statement/v1",
		subject: [{ name: subjectName, digest: { sha512: subjectSha512 } }],
		predicateType: SLSA_PROVENANCE_PREDICATE_TYPE,
		predicate: {
			buildDefinition: {
				buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
				externalParameters: {
					workflow: { ref: workflowRef, repository, path: workflowPath },
					inputs: {},
				},
				internalParameters: {
					github: { event_name: "push", repository_id: "1", repository_owner_id: "1" },
				},
				resolvedDependencies: [
					{ uri: `git+${repository}@${workflowRef}`, digest: { gitCommit } },
				],
			},
			runDetails: {
				builder: { id: "https://github.com/actions/runner/github-hosted" },
				metadata: { invocationId: `${repository}/actions/runs/1/attempts/1` },
			},
		},
	};
}

function dsseBundle(statement, { keyid }) {
	return {
		mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
		verificationMaterial: {
			certificate: { rawBytes: Buffer.from("fixture-signing-certificate").toString("base64") },
			tlogEntries: [
				{
					logIndex: "1",
					logId: { keyId: Buffer.from("fixture-log-id").toString("base64") },
					kindVersion: { kind: "dsse", version: "0.0.1" },
					integratedTime: "1757000000",
					inclusionPromise: { signedEntryTimestamp: Buffer.from("fixture-set").toString("base64") },
				},
			],
		},
		dsseEnvelope: {
			payloadType: "application/vnd.in-toto+json",
			payload: Buffer.from(JSON.stringify(statement), "utf8").toString("base64"),
			signatures: [{ sig: Buffer.from("fixture-signature").toString("base64"), keyid }],
		},
	};
}

/**
 * One `verified[].attestationBundles` array in npm 11.19.0's real shape.
 * `statementOverride` replaces only the SLSA entry's signed payload, which is
 * how the negative controls model a substituted or altered statement.
 */
export function buildAttestationBundles(identity, statementOverride) {
	const provenanceStatement = statementOverride ?? buildProvenanceStatement(identity);
	return [
		{
			predicateType: NPM_PUBLISH_PREDICATE_TYPE,
			bundle: dsseBundle(
				{
					_type: "https://in-toto.io/Statement/v1",
					subject: [{ name: identity.subjectName, digest: { sha512: identity.subjectSha512 } }],
					predicateType: NPM_PUBLISH_PREDICATE_TYPE,
					predicate: {},
				},
				{ keyid: "SHA256:jl3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA" },
			),
		},
		{
			predicateType: SLSA_PROVENANCE_PREDICATE_TYPE,
			bundle: dsseBundle(provenanceStatement, { keyid: "" }),
		},
	];
}

/** One `verified[]` entry, exactly as `npm audit signatures --json --include-attestations` emits it. */
export function buildVerifiedPackage({ name, version, identity, statementOverride }) {
	return {
		name,
		version,
		location: `node_modules/${name}`,
		registry: "https://registry.npmjs.org/",
		attestations: {
			url: `https://registry.npmjs.org/-/npm/v1/attestations/${name}@${version}`,
			provenance: { predicateType: SLSA_PROVENANCE_PREDICATE_TYPE },
		},
		attestationBundles: buildAttestationBundles(identity, statementOverride),
	};
}
