# Mastra Code

Mastra Code is a terminal-based AI coding agent distributed as the `mastracode` package. It combines persistent project-scoped conversations, multiple model providers, coding tools, goals, plugins, dynamic workflows, and Observational Memory so long-running work does not depend on context-window compaction.

## Installation

Mastra Code requires Node.js 22.19.0 or later. Install the CLI globally:

```bash
npm install -g mastracode
```

To use the programmatic API or build a custom TUI, install it as a project dependency instead:

```bash
npm install mastracode
```

## Usage

Start Mastra Code from the project you want it to work in:

```bash
cd your-project
mastracode
```

Or run it without a global installation:

```bash
npx mastracode
```

On first launch, the onboarding wizard connects a model provider, configures model packs and Observational Memory, and asks whether tool calls should require approval. Run `/setup` to repeat onboarding later.

## Machine-readable commands in this fork

These commands are extensions in this fork. Install a compatible fork build;
the same package name or an upstream version does not establish compatibility.

```bash
mastracode info --json
mastracode auth status --provider openai-codex --json
mastracode auth login --provider openai-codex --device --jsonl
mastracode auth logout --provider openai-codex --json
```

Use the argument order shown above. Other arguments return exit code 2 and
`{"type":"error","code":"INVALID_ARGUMENTS"}`. Stdout contains JSON only,
one object per line. Diagnostics belong on stderr. Never parse stderr as protocol
data or publish login codes in logs.

`info` emits one object with `schemaVersion: 1`, the CLI version, ACP protocol
version, capabilities, models, and `auth.provider` / `auth.status`. It does not
start an agent or create storage. Auth status is `authenticated`,
`unauthenticated`, or `unknown`; unknown storage status returns exit code 1.
Model discovery is not proof that a subsequent inference request will succeed.

`auth status` reads storage without creating it and emits a `status` event.
Unauthenticated status is a successful query (exit code 0). Unreadable or malformed
storage emits `AUTH_STORE_UNREADABLE` and exits 1.

`auth login` performs native OpenAI Codex device authorization. Its JSONL events
include `device_code` with `verificationUrl`, `userCode`, and `expiresAt`, optional
`progress` events, and a terminal `success` or `error`. A successful login exits
0; `LOGIN_FAILED` exits 1; cancellation emits `LOGIN_CANCELLED` and exits 130.
Only `success` proves that authorization and credential persistence completed.
Consumers must not require a progress event or assume its position relative to
the device-code event. Account metadata, when present, contains only an ID and
label, not access or refresh tokens.

`auth logout` removes this store's OpenAI Codex credentials and emits an
unauthenticated `status` with exit code 0, or `LOGOUT_FAILED` with exit code 1.
It does not log out other applications or their independent credential stores.

Set `MASTRA_APP_DATA_DIR` consistently for all commands and ACP processes that
belong to one provider instance. Credentials are in its `auth.json`. Do not copy
or symlink another application's refresh tokens into this store. Read-only
metadata commands do not authorize login, logout, or inference as a side effect.

## Documentation

- [Get started with Mastra Code](https://code.mastra.ai/)
- [Configure providers, storage, hooks, MCP servers, and diagnostics](https://code.mastra.ai/configuration)
- [Use Build, Plan, and Fast modes](https://code.mastra.ai/modes)
- [Run persistent goals](https://code.mastra.ai/goals)
- [Use Mastra Code in headless and CI environments](https://code.mastra.ai/headless)
- [Customize or embed Mastra Code](https://code.mastra.ai/customization)
- [Mastra Code API reference](https://code.mastra.ai/reference)

## Changelog

See the [package changelog](https://github.com/mastra-ai/mastra/blob/main/mastracode/tui/CHANGELOG.md) for version history and release notes.

## Support

We have an [open community Discord](https://discord.gg/mastra-ai). Come and say hello and let us know if you have any questions or need any help getting things running.
