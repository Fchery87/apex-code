# Development

See [AGENTS.md](https://github.com/Fchery87/apex-code/blob/main/AGENTS.md) for additional guidelines.

## Setup

```bash
git clone https://github.com/Fchery87/apex-code
cd apex-code
npm install
npm run build
```

Run tests from source:

```bash
/path/to/apex-code/test.sh
```

The script can be run from any directory. Apex Code keeps the caller's current working directory.

## Forking / Rebranding

Apex Code itself is a fork of Pi configured this way. Configure via `package.json`:

```json
{
  "piConfig": {
    "name": "apex-code",
    "configDir": ".apex-code"
  }
}
```

Change `name`, `configDir`, and `bin` field for your own fork. Affects CLI banner, config paths, and environment variable names. `piConfig` is the retained upstream key name for this mechanism, not a reference to a running "pi" product.

## Path Resolution

Three execution modes: npm install, standalone binary, tsx from source.

**Always use `src/config.ts`** for package assets:

```typescript
import { getPackageDir, getThemeDir } from "./config.js";
```

Never use `__dirname` directly for package assets.

## Debug Command

`/debug` (hidden) writes to `~/.apex-code/agent/apex-code-debug.log`:
- Rendered TUI lines with ANSI codes
- Last messages sent to the LLM

## Testing

```bash
./test.sh                         # Run non-LLM tests (no API keys needed)
npm test                          # Run all tests
npm test -- test/specific.test.ts # Run specific test
```

## Project Structure

```
packages/
  ai/           # LLM provider abstraction
  agent/        # Agent loop and message types  
  tui/          # Terminal UI components
  coding-agent/ # CLI and interactive mode
```
