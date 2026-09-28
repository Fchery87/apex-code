# Run Apex Code in an isolated Windows environment

Apex Code has no built-in OS sandbox. Its tools run with the permissions of the
account that starts the CLI. For untrusted code, run Apex Code inside an environment
that exposes only the files, credentials, and network access the task needs.

For ongoing development, use a WSL 2 based container. For a short, disposable
inspection, use Windows Sandbox when your Windows edition supports it.

## Use a WSL 2 container for ongoing work

1. Install WSL 2 and Docker Desktop with its WSL 2 backend. Follow Microsoft's
   [Dev Containers setup for Windows](https://learn.microsoft.com/en-us/windows/dev-environment/docker/dev-containers).
2. Keep the project in the WSL 2 filesystem, such as `~/src/project`, and open it
   from your WSL distribution.
3. Create or review the dev container configuration before you start Apex Code.
   Mount only the project files the task needs. Do not expose your home directory,
   SSH agent, credential store, or Docker socket to the container.
4. Use Node.js 22.19.0 or newer inside the container, then install and start Apex Code:

   ```bash
   npm install --global apex-code
   apex-code
   ```

   Provide a model credential only when the session needs one. The session can read
   every file and credential that the container can access.
5. Limit container network access when the task does not need it. Apex Code needs
   network access to contact the configured model provider.

A container's isolation depends on its configuration. A privileged container, a
host directory mount, or an exposed Docker socket can give code access beyond the
container. Review those settings before using the container with untrusted code.

## Use Windows Sandbox for disposable inspection

Windows Sandbox is a temporary, hypervisor-isolated Windows environment. It is
available on supported Pro, Enterprise, Education, and Pro Education editions; it is
not available on Windows Home. See Microsoft's [Windows Sandbox overview](https://learn.microsoft.com/en-us/windows/security/threat-protection/windows-sandbox/windows-sandbox-overview)
and [configuration guide](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file).

1. Start Windows Sandbox and copy or clone the project into the sandbox. Avoid
   mapping a host folder with write access.
2. Install Apex Code and any tools the project needs inside the sandbox.
3. Keep networking disabled for offline inspection. Windows Sandbox enables
   networking by default. If Apex Code needs to contact a model provider, review
   the network access before enabling it.
4. Save any reviewed changes you want to keep outside the sandbox before closing
   it. Windows Sandbox deletes its files and state when it closes.

Windows Sandbox suits short checks. Use a container or a dedicated VM for work that
needs a persistent project environment. For Apex Code's permission behavior and
security limits, see [SECURITY.md](../SECURITY.md).
