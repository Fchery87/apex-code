import { tmpdir } from "node:os";

/**
 * The directory the supervisor puts its own private state in.
 *
 * `/tmp` on POSIX rather than `TMPDIR`, deliberately, for two reasons the channel code
 * depends on. `TMPDIR` can point inside the workspace on macOS, which the sandbox may
 * write, and a socket has to fit inside `AF_UNIX`'s 108-byte `sun_path`, which an
 * unusually long `TMPDIR` exhausts.
 *
 * Windows has neither `/tmp` nor Unix sockets. Nothing here is reachable in a Windows
 * session, because ADR 0005 leaves that platform unsupported and both backends report
 * `unavailable` before a launch gets this far. It still has to resolve to something real:
 * these helpers are called before the backend's platform check in one path, and off-platform
 * in the tests that exercise violation attribution without a macOS host. Returning
 * `os.tmpdir()` there turns a confusing `ENOENT: mkdtemp '/tmp/...'` into the accurate
 * "OS sandbox is supported on macOS only."
 */
export function supervisorTempDirectory(): string {
	return process.platform === "win32" ? tmpdir() : "/tmp";
}
