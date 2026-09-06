# Sandbox and supervisor audit

## Scope

Audited checkout HEAD `2477e594ef1479d1cb4467f0bc50c2e14fcd3e00`. The audit was requested as of September 3, 2026, but this HEAD contains September 4 changes. This is an audit of the current checkout, not a reconstructed September 3 snapshot. No application code or tracked tests were changed. No real credential was read by a probe. The host Git probes use an isolated environment and synthetic credentials.

Read ADRs 0005, 0016, 0023, and 0024, plus the OS sandbox, supervisor-mediated credential writes, and sandbox delegation/escalation specs. Findings below distinguish confirmed behavior, static defects, and accepted limits. Linux Bubblewrap works on this host. I did not run macOS.

Source paths below are relative to `packages/coding-agent/src/`, unless prefixed with `docs/` or `test/`.

## How the boundary works

1. `cli.ts:20-54` reads argv and decides whether the invocation needs the whole-process sandbox. Full access is an explicit CLI choice with a banner and confirmation. The normal session path resolves global network settings and named profiles, host auth path, host tool binaries, and host skill roots before launching the child. Project settings do not decide outer policy. See `cli.ts:54-106` and `core/sandbox/cli-launch.ts:40-50`.
2. `core/sandbox/cli-supervisor.ts:53-65` canonicalizes the workspace and extra writable roots, selects Linux or macOS, and constructs the supervisor. It acquires a session lease, opens the host credential writer, synthesizes global Git identity, builds the child environment, and delegates launch. `core/sandbox/supervisor.ts:54-56` rejects an unavailable backend instead of invoking the CLI without confinement. Errors return 1 and cleanup runs in `cli-supervisor.ts:128-145`.
3. Linux launches `bwrap` with separate user, PID, and network namespaces. It binds host `/` read-only, overlays `/home` with tmpfs, projects required runtime paths and selected credential files, binds workspace and explicit extra roots writable, and replaces `/dev` and `/proc`. The child runs a local TCP-to-Unix-socket relay and then the internal CLI entry. See `core/sandbox/bwrap-arguments.ts:88-124` and `linux-backend.ts:239-275`.
4. macOS generates a Seatbelt profile and invokes `sandbox-exec`. Reads are broadly allowed except the invoking home, with exceptions for runtime paths, projected files, workspace, and extra roots. Writes are limited to workspace and extra roots. Networking is denied except the supervisor proxy's exact loopback port and explicit RPC socket paths. It has no private network/PID namespace. See `core/sandbox/macos-backend.ts:229-320`.
5. The child receives a filtered environment, repointed HOME/XDG/session directories, explicit provider/tool credentials, and auth/channel paths. Filtering excludes arbitrary ambient variables, but provider keys are deliberately visible to all code in the child. Auth reads are projected; modify/delete operations go through the supervisor's host AuthStorage lock. Credential frames are byte-bounded and validated. New credential values cannot contain command or environment references. See `core/sandbox/cli-launch.ts:146-228,281-343` and `rpc/credential-proxy.ts:203-273`.
6. The network proxy accepts CONNECT only. A configured hostname allows every port unless the entry pins a port. Refused host/port pairs can receive a session-only grant. The supervisor serializes approval prompts through a workspace-file terminal handoff. Git credential release has a separate human grant plus a host-reachability gate. Command escalation is intended to run one second child with one extra writable root. See `core/sandbox/network-proxy.ts:49-88,92-155`, `host-approval.ts:31-75`, and the RPC files below.
7. `core/sandbox/child-entry.ts:22` enters normal `main()` directly and assigns lease ownership to the supervisor. No environment sentinel is accepted by the public CLI as proof of sandboxing. The internal entry itself does not attest confinement; callers must use the public launcher.

## Findings

### S1. High, confirmed: host Git credential lookup executes workspace configuration

**Actor and prerequisites.** Malicious code inside an allowed workspace can write `.git/config`. A human releases a Git credential for a reachable host, or that host was already released earlier in the session. The attacker does not need approval for a host command.

`core/sandbox/rpc/git-credential-proxy.ts:97-109` checks reachability and release, then calls the host lookup. Both platform callers pass only the supervisor environment, not a safe cwd: `linux-backend.ts:165-166` and `macos-backend.ts:189-191`. `rpc/git-credential-helper.ts:141-145` runs unsandboxed `git credential fill` with `cwd: options?.cwd`, which is undefined in production. Git therefore reads the workspace's repository configuration. A workspace-controlled `credential.helper = !...` runs as the host user, outside the OS boundary.

**Consequence.** A grant described as reading a host credential can instead execute an attacker command with host filesystem and network access. This contradicts ADR 0016's prohibition on project input becoming supervisor command authority.

**Check.** The retained `boundaries.mts` creates a scratch Git repository, sets a helper that only writes a scratch marker and emits dummy credentials, then calls the real exported lookup with no cwd. Output: `WORKSPACE_HELPER_EXECUTED_ON_HOST=true`.

**Remedy.** Run Git from a supervisor-owned non-repository directory. Remove repository discovery overrides such as GIT_DIR/GIT_WORK_TREE and configuration injection variables from the lookup environment. Preserve only explicitly supported host credential configuration. Add a test at the actual channel/backend caller proving workspace helpers cannot execute.

### S2. High, confirmed: unvalidated protocol changes the credential host after approval

**Actor and prerequisites.** Any descendant that can reach the Git credential socket, after the requested allowlisted host has been released. This does not require a malicious Git repository.

`rpc/git-credential-proxy.ts:97-109` accepts any string as `protocol`, checks only `host`, and forwards both. `rpc/git-credential-helper.ts:166` interpolates protocol directly into Git's newline-delimited input. A protocol string `https\nhost=other.invalid\n\n` terminates the request before the separately checked host line. Git asks the credential helper about `other.invalid` although network/release authorization was for `allowed.invalid`.

**Consequence.** The released host grant can fetch another host's credential. Git protocol/account fields may also be changed independently of what the human approved.

**Check.** The synthetic capture helper receives exactly `protocol=https\nhost=other.invalid\n`; output is recorded as `INJECTED_GIT_INPUT` in `boundaries.log`. No real host store was consulted.

**Remedy.** Parse protocol into a small supported scheme set, reject CR/LF/NUL in every field, and bind authorization to the exact structured credential identity that is serialized. Add channel-to-real-Git tests, not only a fake `fillCredential` callback.

### S3. High, confirmed: supervisor follows writable-workspace symlinks outside the boundary

**Actor and prerequisites.** An untrusted repository can pre-place symlinks, or a sandboxed descendant can create them in `.apex-code/sandbox-state` during a session. Targets must be writable by the invoking host account.

The supervisor writes into workspace-controlled paths using ordinary symlink-following APIs. `core/sandbox/terminal-handoff.ts:82-88,150-151` writes `terminal-handoff` at every prompt and at backend cleanup. `terminal-size.ts:45-50` writes another fixed path on terminal resize. Startup also writes `relay.cjs` in `linux-backend.ts:177-179`, the Git helper in `rpc/git-credential-helper.ts:121-123`, and macOS's profile in `macos-backend.ts:285-286`. `cli-launch.ts:293-302` creates state directories and clears empty tool files without rejecting symlinked ancestors.

**Consequence.** The child can cause host-side truncation and writes outside its writable mounts. The terminal-handoff case works on normal cleanup, without escalation approval. The payload in that proven case is constrained to `resume\n`, but arbitrary file truncation is still a boundary break. Startup writers provide other fixed payloads.

**Check.** `boundaries.mts` symlinks the scratch workspace's `terminal-handoff` to a scratch file outside the workspace and calls the real handoff `.stop()`. Output: `HANDOFF_OUTSIDE_CONTENT="resume\n"`.

**Remedy.** Keep supervisor-owned writable state outside the workspace. Use dedicated descriptors or a private directory for handoff transport. Where a workspace projection is necessary, reject symlinks through the entire path using descriptor-relative/no-follow operations; checking once before a later path-based write is raceable. Add pre-existing and live replacement tests.

### S4. High, static macOS defect: Seatbelt policy lives in attacker-writable state

**Actor and prerequisites.** A malicious workspace or an already-running sandboxed descendant can change `.apex-code/sandbox-state/profile.sb` while a new sandbox launch occurs. macOS is required.

`core/sandbox/macos-backend.ts:285-286` writes the profile in the writable workspace, then `:301-304` spawns `sandbox-exec -f` pointing to that file. The child can replace or modify it between write and read. This is especially exposed during command escalation because an already-running hostile child exists and escalation reuses the same pathname, `:206-216`.

**Consequence.** A successful race can substitute a permissive profile for the intended policy. The first child cannot be widened in place, but the next child can launch without the expected restrictions. This is distinct from S3's proven symlink truncation.

**Evidence limit.** The unsafe ownership and write/read interval are confirmed by source. I did not demonstrate the race or run Seatbelt on this Linux host.

**Remedy.** Write immutable per-launch profiles in a private supervisor-owned directory outside all child-writable roots. Do not reuse the main session's profile pathname. Prefer a safe descriptor or direct profile argument where supported. Prove substitution resistance on macOS.

### S5. High, confirmed authorization classification defect: metadata-looking argument values skip sandbox launch

`core/sandbox/cli-launch.ts:17-20` scans raw argv for metadata words regardless of position. `cli/args.ts:100-108` treats everything after `--` as message content, and `:128-129` consumes a system-prompt value. Thus `['--print','--','--help']` and `['--print','--system-prompt','--version']` both return false from `requiresSandboxedChild`, while the real parser reports print mode without a help/version request. `cli.ts:110-116` then calls `main()` outside the supervisor. `main.ts:636-655` has no metadata early return for those parsed inputs.

**Actor and prerequisites.** A caller controls message or option-value text forwarded to the CLI by a wrapper, or a user invokes one of these forms expecting normal confinement. Existing malicious code already confined cannot escape merely by nesting this CLI; the outer sandbox still applies.

**Consequence.** A public CLI invocation can construct an ordinary session without the boundary or the explicit full-access banner. Extensions and allowed tools then execute with host authority.

**Check.** `boundaries.log` contains the raw args, `sandbox:false`, and parsed print-mode objects. The parent assigned full entrypoint proof to another worker; this report does not claim my classifier probe ran an agent turn.

**Remedy.** Classify one parsed command representation shared by launcher and runtime. Do not scan unparsed positional or flag-value strings for control flags.

### S6. Medium, confirmed Linux wiring defect: the command-escalation socket is not mounted

`core/sandbox/linux-backend.ts:225-235` starts the escalation service, and `:270` supplies `APEX_COMMAND_ESCALATION_PATH`. But the socket list at `:247-262` mounts only network, credential mutation, and Git credential sockets. `rpc/command-proxy.ts:42` names `/home/apex-command-escalation.sock`, hidden under the private `/home` tmpfs unless explicitly mounted.

**Actor and prerequisites.** Any normal Linux user trying the shipped per-command escalation feature.

**Consequence.** The legitimate child cannot request an approved command. This fails closed but contradicts the landed feature and may push users toward full access.

**Check.** The real Linux backend child printed `ESCALATION_SOCKET_EXISTS=false`. The existing integration test does not cover this path: `packages/coding-agent/test/sandbox/command-escalation.test.ts:224-241` creates a separate test proxy and sends to it from the host.

**Remedy.** Add the missing socket projection and test a request from the real primary child using the injected production approval callback. Check headless denial through the same route.

### S7. Medium, static macOS contract defect: escalation creates a full session backend

`core/sandbox/macos-backend.ts:206-218` handles escalation by recursively calling `createMacosSandboxBackend(options).launch({...launch, command:'/bin/sh', ...})`. It retains all read-only files and the credential channel, starts a network proxy and both additional RPC channels, and inherits terminal stdio via `:319`. It returns empty stdout/stderr rather than command output.

ADR 0024 explicitly says the second child has no network relay, credential channels, or terminal handoff and captures its output. Linux's separate path attempts this smaller shape at `linux-backend.ts:324-347`.

**Actor and prerequisites.** Code run by a human-approved macOS escalated command, or concurrent hostile workspace code that can alter inputs read by that command.

**Consequence.** The command receives extra write authority together with channels and secrets the documented escalation contract withholds. Recreating the backend also overwrites the primary session's handoff/profile files and installs a separate prompt queue. This is excess authority and output/lifecycle drift, not proof of automatic approval bypass.

**Evidence limit.** Static caller trace only; macOS execution not run.

**Remedy.** Build a separate minimal macOS command runner that shares profile generation but omits channels, uses a filtered environment, captures output, and owns its cleanup in `finally`. Also fix Linux's omitted `env` on the escalation spawn at `:347`, which otherwise inherits the entire supervisor environment rather than the filtered child environment.

### S8. Medium, static overprojection: directory inputs expose their parents

`core/sandbox/bwrap-arguments.ts:52-54` binds `dirname(resolve(path))`, not the supplied path. `macos-backend.ts:65-74` likewise authorizes parent directories. This is appropriate for an executable path but is also used for directory paths supplied by `cli-launch.ts:305-306`. A skill root `/home/example/.agents/skills` therefore exposes `/home/example/.agents`, including sibling trees and state. CLI package-directory inputs similarly expose ancestors, `cli.ts:103`.

`cli-launch.ts:110-119` rejects a skill root equal to home or an ancestor, but evaluates the requested root, not the broader parent actually mounted. This means the check and authority do not match.

**Actor and prerequisites.** Malicious child code plus sensitive sibling files in a projected skill/package parent. Exact impact depends on installation and host layout.

**Consequence.** More host data becomes readable than the documented skill subtree projection. A skill-directory parent equal to home can invalidate the home-denial check.

**Check.** Calling the real builder for `/home/example/.agents/skills` produced `--ro-bind /home/example/.agents /home/example/.agents`, retained in `boundaries.log`. No real home content was read.

**Remedy.** Distinguish file inputs from directory inputs in the launch contract. Canonicalize and validate the exact directory that will be exposed. Add sibling-secret refusal tests.

## Accepted limits and further hardening

### Linux host Unix sockets remain reachable, confirmed, high practical impact when a privileged service exists

The root read-only bind in `bwrap-arguments.ts:95-99` exposes pathname Unix sockets outside hidden `/home`. Read-only mounts do not deny socket connections; network namespaces do not isolate pathname AF_UNIX. A child with `allowedHosts: []` reached a synthetic service under a scratch host directory outside its workspace. Output: `UNPROJECTED_HOST_UDS=synthetic-host-service`, `UNPROJECTED_HOST_SERVER_REACHED=true`, child exit 0.

A readable/reachable host container-engine, credential-agent, or user-service socket can supply host authority or network access outside the proxy. This audit did not contact a real sensitive socket. ADR 0005 explicitly excludes arbitrary Unix-socket guarantees, so this is a documented tradeoff with demonstrated exposure, not an undocumented guarantee violation. Narrow root mounts or explicitly hide host runtime/socket directories. At minimum, make the practical exception prominent wherever the product says outbound traffic is denied.

Linux hides only `/home`, `bwrap-arguments.ts:98-99`, rather than the actual invoking home. An account rooted in `/root`, `/var`, or another path retains broad root-read exposure. This is a static home-layout gap; I did not read another home or test a root account. macOS hides the resolved actual home, `macos-backend.ts:237-262`, but not other users' ordinarily readable homes. Workspace or explicit writable roots that include sensitive data intentionally expose that data.

The network proxy uses hostname-string allowlisting, then delegates DNS to `net.connect`, `network-proxy.ts:98-105,138`. It does not reject resolved private/loopback addresses or pin resolution. ADR 0005 already records DNS rebinding and allowed-destination compromise as non-guarantees. Default provider/update hosts are now permitted through `default-hosts.ts:21-69`; deny-all requires global `allowDefaultHosts:false`, `cli-launch.ts:43-44`. Allowed endpoints remain possible exfiltration destinations.

Proxy lifecycle/input hardening is weaker than credential mutation RPC. CONNECT ports are not range-validated before `net.connect`; configured bare hosts can reach a synchronous invalid-port exception at `network-proxy.ts:138`. There is no connection cap or explicit active-tunnel destruction in `close`, `:173,191`. Git/command RPCs bound concurrent sockets but do not apply credential writer's idle timeout. These are static denial-of-service candidates, not reproduced crashes in this audit.

Prompt authority is supervisor-side, but it uses inherited `process.stdin/stdout` TTY status, `host-approval.ts:35-37`, rather than opening `/dev/tty` as ADR 0023 specifies. Print/JSON/RPC started with TTY descriptors can still get an approver. The handoff asks rather than forcibly suspends hostile child output. Command text and writable roots are printed without escaping, `host-approval.ts:123-133`, and `command-proxy.ts:79-81` does not canonicalize/validate roots or reject terminal controls. These are authority-display and mode-policy gaps. I did not demonstrate forged consent or TTY input injection.

Provider API keys and the auth projection are intentionally readable by sandbox descendants. Credential mutation RPC deliberately permits any descendant to modify/delete literal credentials, with no peer-level distinction. This is the accepted credential-write threat model, not a new finding. The Git release prompt's claim that the credential is never written into the workspace describes supervisor behavior only; once returned, hostile child code can persist it.

## Positive controls

- Backend absence and invalid writable roots refuse startup. There is no silent OS-backend fallback.
- Network/profile policy comes from global settings and explicit argv, not project settings before trust.
- Explicit provider/tool key allowlists prevent automatic forwarding of arbitrary ambient environment variables on the normal CLI launch.
- Credential mutation uses private 0700 endpoint directories, 0600 sockets, 64 KiB frames, a connection cap, an idle timeout, abort handling, and host-side locking. Credential command/environment references are rejected before writing.
- Host reachability and Git credential release are separate grants. Host grants pin the concrete host/port and remain session-local. Command requests are individually approved.
- Linux has real user/PID/network namespaces and a private `/dev` and `/proc`. The live probe confirmed Bubblewrap works here. The defect is what gets re-exposed or executed by the host supervisor, not a simulated sandbox.
- Source preserves the Linux/macOS network difference and Windows refusal. macOS's imported `bsd.sb`, Apple Events/Launch Services behavior, code-signing behavior, and native race resistance still need platform-specific review; this audit makes no claim of new native verification.

## Checks and artifacts

Ran these project-native commands from the repository root. The scripts immediately move into scratch workspaces before exercising stateful behavior and remove their scratch state. The original execution paths were under `/tmp/apex-sandbox-audit-otlphu3t/`; exact copies are retained below so results can be reviewed and rerun.

```text
node --import tsx /tmp/apex-sandbox-audit-otlphu3t/probe.mts
exit_code=0
HANDOFF_OUTSIDE_CONTENT="resume\n"
WORKSPACE_HELPER_EXECUTED_ON_HOST=true
INJECTED_GIT_INPUT="protocol=https\nhost=other.invalid\n"
LAUNCH_CLASSIFICATION={"args":["--print","--","--help"],"sandbox":false,"parsed":{"messages":["--help"],"fileArgs":[],"unknownFlags":{},"diagnostics":[],"print":true}}
LAUNCH_CLASSIFICATION={"args":["--print","--system-prompt","--version"],"sandbox":false,"parsed":{"messages":[],"fileArgs":[],"unknownFlags":{},"diagnostics":[],"print":true,"systemPrompt":"--version"}}
SKILL_MOUNT=["--dir","/home/example","--dir","/home/example/.agents","--ro-bind","/home/example/.agents","/home/example/.agents"]
BWRAP={"status":0,"stderr":""}

node --import tsx /tmp/apex-sandbox-audit-otlphu3t/linux.mts
exit_code=0
ESCALATION_SOCKET_EXISTS=false
UNPROJECTED_HOST_UDS=synthetic-host-service
LINUX_CHILD_EXIT=0
UNPROJECTED_HOST_SERVER_REACHED=true
```

Retained runnable scripts and exact logs:

- `.apex-code/audit-2026-09-03/sandbox-probes/boundaries.mts`
- `.apex-code/audit-2026-09-03/sandbox-probes/boundaries.log`
- `.apex-code/audit-2026-09-03/sandbox-probes/linux.mts`
- `.apex-code/audit-2026-09-03/sandbox-probes/linux.log`

The parent ran the broad sandbox suite and full validation separately. I did not duplicate those runs and do not claim their outcomes as my own verification.
