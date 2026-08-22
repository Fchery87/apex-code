# Environment variables

Apex Code uses canonical `APEX_CODE_*` variables for its owned runtime controls and
subprocess metadata. Provider API-key variables remain documented in
[Providers](providers.md#environment-variables-or-auth-file).

## Runtime controls

| Variable | Description |
| --- | --- |
| `APEX_CODE_CODING_AGENT_DIR` | Config root; defaults to `~/.apex-code/agent` |
| `APEX_CODE_CODING_AGENT_SESSION_DIR` | Override session storage |
| `APEX_CODE_PACKAGE_DIR` | Override package assets (for Nix/Guix paths) |
| `APEX_CODE_OFFLINE` | Disable startup network operations |
| `APEX_CODE_SKIP_VERSION_CHECK` | Disable the npm `apex-code@next` version request |
| `APEX_CODE_EXPERIMENTAL` | Enable experimental features when set to `1` |
| `APEX_CODE_STARTUP_BENCHMARK` | Enable startup benchmarking |
| `APEX_CODE_TIMING` | Enable timing diagnostics when set to `1` |
| `APEX_CODE_CLEAR_ON_SHRINK` | Clear context on shrink when set to `1` |
| `APEX_CODE_HARDWARE_CURSOR` | Show the hardware cursor when set to `1` |
| `APEX_CODE_MODEL_CATALOG_URL` | Optional base URL for remote model catalog overlays; unset uses bundled catalogs only |
| `APEX_CODE_SHARE_VIEWER_URL` | Optional base URL for preview links after `/share`; unset returns the GitHub Gist URL only |
| `VISUAL`, `EDITOR` | External editor fallback |
| `HTTP_PROXY`, `HTTPS_PROXY` | Proxy outbound HTTP requests |
| `EXA_API_KEY` | Key for the `web_search` tool's Exa backend; unset leaves `web_search` unconfigured |

The CLI and RPC entry points set `APEX_CODE_CODING_AGENT=true`. Commands run through
the built-in bash tool receive `APEX_CODE_SESSION_ID`, `APEX_CODE_SESSION_FILE`,
`APEX_CODE_PROVIDER`, `APEX_CODE_MODEL`, and `APEX_CODE_REASONING_LEVEL`. Values are
resolved when each command starts. User-entered `!` and `!!` commands do not receive
this session metadata.

```bash
printf '%s/%s\n' "$APEX_CODE_PROVIDER" "$APEX_CODE_MODEL"
printf 'reasoning=%s session=%s\n' "$APEX_CODE_REASONING_LEVEL" "$APEX_CODE_SESSION_ID"
```

## Temporary legacy aliases

The equivalent `PI_*` names remain aliases during the compatibility window. Apex Code
reads the canonical name first; when both are set, the canonical value wins. A
legacy-only read emits one deprecation diagnostic per process. Apex Code exports both
forms to child processes during this window so existing scripts continue working.

Legacy aliases will be removed no earlier than Apex Code 1.0.0 and no earlier than
2027-02-16. Removal requires release notes and an intentional compatibility-test
change. Consumed dependency variables, provider API-key variables, and extension API
vocabulary are not part of this rename.
