# PS.4 — Harden Git credential execution and protocol validation

**Owner:** PS.4 implementation owner
**Branch:** `main`, working tree only. Nothing staged, committed, stashed, reset, or
switched. Other owners' unrelated working-tree changes were left untouched.
**Never accessed:** `c-code`.
**Specification:** `.apex-code/security-remediation/ps-design.md` § 3.4 (traces in § 2.3,
compatibility traps 3 and 4 in § 4).

## 1. Files changed

Exactly three, as scoped:

| File | Change |
|---|---|
| `packages/coding-agent/src/core/sandbox/rpc/git-credential-proxy.ts` | Added exported `parseGitCredentialRequest()` and `GitCredentialRequestParse`. `answer()` now parses first, refuses with an audit entry that does not echo the refused bytes, and authorizes / releases / serves **only** the parsed identity. |
| `packages/coding-agent/src/core/sandbox/rpc/git-credential-helper.ts` | `fillHostGitCredential()` now re-parses the request (defence in depth for the SDK path), runs `git credential fill` with `cwd` set to a fresh private `0700` empty directory created per call and removed afterwards, strips `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_CONFIG` from whatever environment it is given, and sets `GIT_CEILING_DIRECTORIES` to the (realpath-resolved) parent of that directory. The `cwd` option was removed from the signature so the private directory is the only path. `HOME` and global/system config are preserved. |
| `packages/coding-agent/test/sandbox/git-credential-channel.test.ts` | 18 new tests: 14 injection refusals, an audit-hygiene test, 3 positive controls (`ssh`, `git+ssh`, scheme lowercasing), and 4 host-side tests covering the hostile repository helper, `GIT_DIR`/`GIT_CONFIG` injection, the preserved global helper, and refusal-before-spawn. |

Nothing else was touched. `git status --porcelain` still shows every other owner's
modified and untracked paths unchanged.

### What the validation actually is

Structural, not an allowlist, per compatibility trap 4:

- `host` and `protocol` are refused if they contain any character matching
  ``/[\s\u0000-\u001f\u007f-\u009f]/u`` — LF, CR, NUL, tab, space, DEL, C1 controls, and
  Unicode whitespace (`\s` covers U+00A0, U+2028, U+2029, and the rest).
- `host` must be a string, non-empty, and at most 255 characters.
- `protocol` is lowercased, then must match `/^[a-z][a-z0-9+.-]*$/` and be at most 32
  characters. An absent `protocol` still defaults to `https` (unchanged behaviour); a
  present non-string is refused rather than silently defaulted, which is what the old code
  did.
- `ssh` and custom schemes (`git+ssh`) keep working; there is no `https` allowlist.

## 2. Acceptance, clause by clause

Plan row PS.4: *"A hostile repository helper does not execute. Newline, carriage return,
NUL, scheme, and host injection fail before authorization."*

### Pre-change baseline (independent of the test suite)

Before writing any test I reproduced the primitive at the shell, using a scratch repo under
the OS temp dir and a scratch `HOME` (no live credentials, no network):

```text
$ git init -q repo && git -C repo config credential.helper '!f() { touch .../MARKER; }; f'
--- baseline: cwd=repo, no ceiling ---
fatal: could not read Username for 'https://github.com': terminal prompts disabled
exit=128
/tmp/.../gitprobe/MARKER            <- the repository's helper ran on the host

--- fix: cwd=empty private dir ---
fatal: could not read Username for 'https://github.com': terminal prompts disabled
exit=128
no marker (good)

--- GIT_DIR injection with cwd=empty ---
/tmp/.../gitprobe/MARKER
MARKER CREATED                       <- private cwd alone is not enough; GIT_DIR must go

--- nested: repo above empty dir, ceiling = the cwd itself ---
MARKER CREATED (ceiling on cwd does NOT stop parent walk)

--- nested with ceiling = the parent ---
no marker (ceiling=parent stops walk)
```

That last pair is why `GIT_CEILING_DIRECTORIES` is set to the *parent* of the working
directory rather than to the working directory itself, which is what a literal reading of
the design note would have produced and which does nothing.

### Failing-test output before the change

`npm --prefix packages/coding-agent test -- test/sandbox/git-credential-channel.test.ts`

```text
 RUN  v4.1.9 /home/nochaserz/Documents/Coding Projects/apex-code/packages/coding-agent

···········xxxxxxxxxxxx·xx··xxx·x······

⎯⎯⎯⎯⎯⎯ Failed Tests 18 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/sandbox/git-credential-channel.test.ts > git credential request validation > refuses newline in protocol before authorization
 FAIL  test/sandbox/git-credential-channel.test.ts > git credential request validation > refuses newline in host before authorization
 FAIL  test/sandbox/git-credential-channel.test.ts > git credential request validation > refuses carriage return in protocol before authorization
 FAIL  test/sandbox/git-credential-channel.test.ts > git credential request validation > refuses carriage return in host before authorization
 FAIL  test/sandbox/git-credential-channel.test.ts > git credential request validation > refuses NUL in protocol before authorization
 FAIL  test/sandbox/git-credential-channel.test.ts > git credential request validation > refuses NUL in host before authorization
 FAIL  test/sandbox/git-credential-channel.test.ts > git credential request validation > refuses space in host before authorization
 FAIL  test/sandbox/git-credential-channel.test.ts > git credential request validation > refuses tab in protocol before authorization
 FAIL  test/sandbox/git-credential-channel.test.ts > git credential request validation > refuses scheme with a separator before authorization
 FAIL  test/sandbox/git-credential-channel.test.ts > git credential request validation > refuses scheme starting with a digit before authorization
 FAIL  test/sandbox/git-credential-channel.test.ts > git credential request validation > refuses empty scheme before authorization
 FAIL  test/sandbox/git-credential-channel.test.ts > git credential request validation > refuses non-string protocol before authorization
 FAIL  test/sandbox/git-credential-channel.test.ts > git credential request validation > refuses whitespace-only host before authorization
AssertionError: expected true to be false // Object.is equality

- Expected
+ Received

- false
+ true

 ❯ test/sandbox/git-credential-channel.test.ts:300:24
    298|    const response = await ask(watched.path, { op: "get", ...injection.…
    299|
    300|    expect(response.ok).toBe(false);
       |                        ^
    301|    expect(watched.allowedFor).toEqual([]);
    302|    expect(watched.released).toEqual([]);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/18]⎯

 FAIL  test/sandbox/git-credential-channel.test.ts > git credential request validation > records a refused request without echoing the injected bytes into the audit tail
AssertionError: expected [] to have a length of 1 but got +0

- Expected
+ Received

- 1
+ 0

 ❯ test/sandbox/git-credential-channel.test.ts:323:22
    321|
    322|   const violations = violationStore.list();
    323|   expect(violations).toHaveLength(1);
       |                      ^
    324|   expect(violations[0].detail).not.toContain("other.invalid");
    325|   expect(violations[0].detail).not.toContain("\n");

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/18]⎯

 FAIL  test/sandbox/git-credential-channel.test.ts > git credential request validation > authorizes and serves exactly one parsed identity, with the scheme lowercased
AssertionError: expected [ { host: 'github.com', …(1) } ] to deeply equal [ { host: 'github.com', …(1) } ]

- Expected
+ Received

  [
    {
      "host": "github.com",
-     "protocol": "https",
+     "protocol": "HTTPS",
    },
  ]

 ❯ test/sandbox/git-credential-channel.test.ts:354:26
    352|   expect(watched.allowedFor).toEqual(["github.com"]);
    353|   expect(watched.released).toEqual(["github.com"]);
    354|   expect(watched.filled).toEqual([{ host: "github.com", protocol: "htt…
       |                          ^
    355|  });
    356| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/18]⎯

 FAIL  test/sandbox/git-credential-channel.test.ts > host git credential resolution is not run inside a repository > never executes the credential helper of the repository the supervisor happens to stand in
AssertionError: expected true to be false // Object.is equality

- Expected
+ Received

- false
+ true

 ❯ test/sandbox/git-credential-channel.test.ts:404:35
    402|   }
    403|
    404|   expect(existsSync(tree.marker)).toBe(false);
       |                                   ^
    405|  });
    406|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/18]⎯

 FAIL  test/sandbox/git-credential-channel.test.ts > host git credential resolution is not run inside a repository > never executes a helper reached through GIT_DIR or GIT_CONFIG in the inherited environment
AssertionError: expected true to be false // Object.is equality

- Expected
+ Received

- false
+ true

 ❯ test/sandbox/git-credential-channel.test.ts:420:35
    418|   ).resolves.toBeUndefined();
    419|
    420|   expect(existsSync(tree.marker)).toBe(false);
       |                                   ^
    421|  });
    422|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[5/18]⎯

 FAIL  test/sandbox/git-credential-channel.test.ts > host git credential resolution is not run inside a repository > refuses to serialize an injected identity, so git is never spawned for it
AssertionError: expected true to be false // Object.is equality

- Expected
+ Received

- false
+ true

 ❯ test/sandbox/git-credential-channel.test.ts:456:35
    454|   ).resolves.toBeUndefined();
    455|
    456|   expect(existsSync(tree.marker)).toBe(false);
       |                                   ^
    457|  });
    458| });

 Test Files  1 failed (1)
      Tests  18 failed | 21 passed (39)
   Start at  02:48:48
   Duration  6.66s (transform 1.07s, setup 0ms, import 1.46s, tests 3.85s, environment 0ms)
```

Every failure is for the right reason: the injected request was **accepted**
(`response.ok` was `true`, and `allowedFor`/`released`/`filled` recorded the injected
identity), and the hostile repository's `credential.helper` **ran on the host** (the marker
file existed). The 21 that passed at this point are the file's pre-existing tests plus the
three positive controls (`ssh`, `git+ssh`, the preserved global helper), which is what a
positive control is for — they must pass before and after.

### Passing output after the change

```text
> apex-code@0.0.1-alpha.11 test
> vitest --run test/sandbox/git-credential-channel.test.ts


 RUN  v4.1.9 /home/nochaserz/Documents/Coding Projects/apex-code/packages/coding-agent

·······································

 Test Files  1 passed (1)
      Tests  39 passed (39)
   Start at  02:56:05
   Duration  5.81s (transform 883ms, setup 0ms, import 1.27s, tests 2.82s, environment 0ms)
```

### Disposition table

| Acceptance clause | Test | Disposition |
|---|---|---|
| Newline injection fails before authorization | `refuses newline in protocol/host before authorization` | **Proven.** Response is `ok:false`; `isHostAllowed`, `requestRelease` and `fillCredential` recorded zero calls. |
| Carriage return injection | `refuses carriage return in protocol/host …` | **Proven**, same assertions. |
| NUL injection | `refuses NUL in protocol/host …` | **Proven**, using a literal U+0000 in the JSON frame. |
| Scheme injection | `refuses scheme with a separator`, `… starting with a digit`, `… empty scheme`, `… non-string protocol`, `… tab in protocol` | **Proven** for those five shapes. |
| Host injection | `refuses space in host`, `… whitespace-only host`, `refuses non-string host`, plus the CR/LF/NUL host cases | **Proven** for control/whitespace/type shapes. See narrowing (a) below — this is not a hostname grammar. |
| Fails *before* authorization | every case above asserts `allowedFor === []` and `released === []` | **Proven.** The parse happens before `isHostAllowed`, so a refused request never reaches the reachability check or the release prompt with an attacker-chosen host. |
| Released host cannot differ from served host | `authorizes and serves exactly one parsed identity, with the scheme lowercased` | **Proven** at the boundary: one parsed value flows into `isHostAllowed`, `release` and `fillCredential`, and `fillHostGitCredential` serializes the value it re-parsed rather than the caller's raw fields. |
| A hostile repository helper does not execute | `never executes the credential helper of the repository the supervisor happens to stand in` | **Proven** for the cwd vector: the test `chdir`s the test process into a scratch repo whose local `credential.helper` is `!f() { touch <marker>; }; f`, calls `fillHostGitCredential`, and asserts the marker was never created. Failed before, passes after. |
| A hostile repository helper does not execute (env vector) | `never executes a helper reached through GIT_DIR or GIT_CONFIG in the inherited environment` | **Proven.** `GIT_DIR`, `GIT_WORK_TREE` and `GIT_CONFIG` pointing at the hostile repo produce no marker. |
| `ssh` and custom schemes still work | `keeps ssh working …`, `keeps a custom helper scheme working` | **Proven** (positive controls; passed before and after). |
| `HOME`/global config preserved so gh, libsecret, keychain still resolve | `still resolves the host's global helper …` | **Proven** with a real `~/.gitconfig` helper resolved by real git, run while `chdir`ed inside the hostile repo — the global helper answers and the repository helper does not run. |
| No credential leaks into a refusal or the audit tail | `records a refused request …`, pre-existing `audits a refusal …` | **Proven.** The audit detail names the offending *field*, never the bytes, so a refused CR/LF payload cannot be written into a tail a human reads in a terminal. |

## 3. Gate output

### `npm --prefix packages/coding-agent test -- test/sandbox/git-credential-channel.test.ts`

```text
> apex-code@0.0.1-alpha.11 test
> vitest --run test/sandbox/git-credential-channel.test.ts


 RUN  v4.1.9 /home/nochaserz/Documents/Coding Projects/apex-code/packages/coding-agent

·······································

 Test Files  1 passed (1)
      Tests  39 passed (39)
   Start at  02:56:05
   Duration  5.81s (transform 883ms, setup 0ms, import 1.27s, tests 2.82s, environment 0ms)
```

### `npx tsgo --noEmit` (repo root)

```text
$ npx tsgo --noEmit
tsgo exit=0
```

No output, exit status 0.

### Wider check I also ran (not required, but the seam's neighbours)

`npm --prefix packages/coding-agent test -- test/sandbox/`

```text
 Test Files  28 passed (28)
      Tests  248 passed | 8 skipped (256)
   Start at  02:52:45
   Duration  172.09s (transform 73.63s, setup 0ms, import 162.73s, tests 265.75s, environment 0ms)
```

(The interleaved `Read-only file system` / `Operation not permitted` lines in that run are
the sandbox tests' own expected refusal output, not failures.)

Formatting/lint: `npx biome check --write --error-on-warnings` was run **scoped to my three
files only** (`Checked 3 files. Fixed 3 files.`), deliberately not repo-wide, so it could
not reformat another owner's in-flight edits. The focused test and `tsgo` above were re-run
after that reformat.

## 4. Claims I deliberately narrowed, and what I did not prove

Read this section before treating PS.4 as closed.

**(a) Host validation is structural, not a hostname grammar.** A host is refused for
control characters, whitespace, emptiness, wrong type, or length > 255. It is *not* checked
against a DNS/IPv6/port grammar, so `evil.invalid/../x`, `a=b`, `..`, and IDN labels all
parse. That is deliberate: a hostname grammar would break IDN, `host:port`, and bracketed
IPv6, and compatibility trap 4 warns against exactly that kind of over-narrowing. The
security argument is confined to what is provable: none of those strings can *break out of
a field* in git's line protocol, and any of them still has to pass `isHostAllowed` and a
human release. I did not prove they are harmless to every downstream consumer of the host
string.

**(b) The length bounds (255 host / 32 protocol) are my addition, not the design note's.**
They are defensible (the frame reader's 64 KiB cap is far looser) but they are a narrowing
of accepted input that the specification did not ask for. If a real host name legitimately
exceeds 255 characters, this refuses it.

**(c) `GIT_CEILING_DIRECTORIES` is verified only by shell probe, not by a test.** The
regression tests prove the private empty `cwd` and the stripped environment variables. The
ceiling only changes behaviour if `supervisorTempDirectory()` (`/tmp`) is itself inside a
git repository, which I cannot construct from a test without writing outside a scratch
directory. Its correctness rests on the four-case shell probe quoted in § 2, which also
showed that a ceiling set to the working directory itself is useless. Treat the ceiling as
an unverified second guard.

**(d) I did not run `npm test` (full suite).** Four other owners are editing this same
working tree concurrently (`permissions/`, `tools/`, `scripts/`, docs). A full-suite result
now would not be attributable to my change in either direction, and AGENTS.md forbids
relabelling such a run. What I ran is the focused file plus all 28 files under
`test/sandbox/`, which is the directory containing every consumer of the two modules I
touched. The full suite remains owed at slice close.

**(e) The sandboxed child's own helper (`HELPER_SOURCE`) was not changed.** It still
`trim()`s values and builds the JSON frame in-process. That is fine because the proxy no
longer trusts anything the child sends — and the tests attack the socket directly with raw
frames rather than going through the helper, which is the stronger attacker model — but I
did not add a second validation layer inside the child, and a child can always bypass the
helper anyway.

**(f) `git credential fill` can still block on a terminal prompt.** Production callers
(`linux-backend.ts`, `macos-backend.ts`) pass `process.env`, which typically has no
`GIT_TERMINAL_PROMPT=0`. If the host has no helper for a released host, git may prompt on
the supervisor's terminal. That is pre-existing behaviour, it is not part of PS.4's
acceptance, and changing it would change credential UX, so I left it. It is a real,
unaddressed availability wart in this code path.

**(g) The private fill directory is created and removed per call.** Cost is one `mkdtemp`,
one `mkdir`, one `realpath` and one recursive `rm` per credential fill. Credential fills are
human-gated and rare, so I did not measure this; I am asserting the cost is negligible by
argument, not by measurement. If `rmSync` fails, the failure is swallowed and an empty
`0700` directory is left under `/tmp` — a leak of empty directories, never of content.

**(h) Removing the `cwd` option from `fillHostGitCredential` is a signature change.** No
in-repo caller passed it (only `{ environment: process.env }` from the two backends). It is
reachable from `linux-backend.ts`'s `fillGitCredential?: typeof fillHostGitCredential` test
seam; TypeScript accepts the existing stubs and `npx tsgo --noEmit` is clean. An
out-of-repo embedder passing `cwd` would silently lose it — but restoring an escape hatch
back into an arbitrary directory would reopen exactly the hole this task closes, so it goes.

**(i) No ADR was written.** § 5 of the design note lists ADRs for PS.2 and PS.5, not PS.4;
the decision recorded here — structural validation over an `https` allowlist — is already
stated in the design note and in compatibility trap 4. If the plan owner wants it durable
before the plan is deleted, it belongs in the security-boundary spec, which I do not own.

**(j) No credentials, no network.** Every test uses `mkdtemp` under the OS temp dir with a
scratch `HOME` and a fake helper printing `username=ada` / `password=from-host-store`.
Nothing was written into this repository; the one test that changes the process working
directory restores it in a `finally`.
