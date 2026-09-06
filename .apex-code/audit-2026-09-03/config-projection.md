## Host permission configuration is not carried into the sandbox child

**High. Confirmed launch/store probe and reviewed live caller.** The normal sandbox startup repoints `APEX_CODE_CODING_AGENT_DIR` to workspace `.apex-code/sandbox-agent`. `main.ts:825-833` constructs the permission store against that directory. Host `permissions.json` is neither projected nor merged. `cli-launch.ts:146-228` also filters out `APEX_CODE_POLICY_PATH`. The store falls back to `/etc/apex-code/policy.json` on Linux and macOS.

A user relying on a host user-level deny can start the normal sandboxed CLI and lose that deny. A custom managed-policy path is also lost. This does **not** mean the default `/etc/apex-code/policy.json` is hidden or ignored. The absent-default-policy condition in the probe models hosts that use only the custom path.

Remedy: resolve host authorization inputs in the supervisor and hand the child an immutable, explicit policy representation. Keep approval persistence outside agent-writable workspace state. Carry custom policy locations through a reviewed projection rather than forwarding arbitrary environment values.

Run `npx tsx .apex-code/audit-2026-09-03/config-projection-probe.ts` from the repository root. Exit 0. Actual output:

```json
{
  "hostRules": [
    {
      "toolName": "write",
      "behavior": "deny",
      "source": "policy"
    },
    {
      "toolName": "bash",
      "behavior": "deny",
      "source": "user"
    }
  ],
  "childRules": [],
  "hostErrors": [],
  "childErrors": [],
  "childPolicyOverride": null,
  "projectedReadOnlyFiles": [],
  "projectedReadOnlyPaths": []
}
```

The probe calls real launch and store APIs, not a live model turn. It creates and removes its own temporary directories. The permission reviewer independently confirmed the production caller has no compensating projection.
