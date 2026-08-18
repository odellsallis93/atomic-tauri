# Atomic desktop proof of concept

Optional Tauri host that starts the existing Atomic engine over `--mode rpc` and renders a basic session. It is not a replacement for the TUI, not on the default install path, and not part of `@bastani/atomic`.

This is the first slice described on [issue 2352](https://github.com/bastani-inc/atomic/issues/2352): a real host consuming the current protocol, so the protocol additions a GUI actually needs can be named from use rather than invented up front.

Phase 1 of this host is making those proofs trustworthy (streaming, tools, abort, queues, dialogs, and a UI that does not hide spawn failure). Phase 2 is the gap record in [PROTOCOL.md](./PROTOCOL.md). Neither phase changes the TUI or the RPC schema.

## Why this shape

Atomic already has a host/engine split. The public embed API is JSONL over stdin/stdout (`atomic --mode rpc`). The TUI uses that same child, plus a private isolation layer (`engine_ready` / `engine_bound` / remote paint). A first desktop host should speak the public RPC. The isolation frames are TUI compositor details; copying them would hide the gaps instead of exposing them.

Placement is `apps/desktop`, outside `packages/*` and outside the Rust natives workspace, so:

- `npm ci` and the published shrinkwrap stay unchanged
- `atomic` still starts the TUI by default
- Tauri, GTK, and WebKit are never required to test or extend the CLI

The webview does not read `~/.atomic` credential or settings files. It spawns the engine and talks JSONL. Session files, auth, tools, and extensions stay in the engine.

## What the PoC renders

- Engine start/stop, with a default command that prefers this checkout's CLI (`bun packages/coding-agent/src/cli.ts --mode rpc`) when present
- A fixture engine (`node apps/desktop/fixtures/mock-rpc-engine.mjs`) so streaming, tools, abort, and dialogs can be proven without an API key
- Session transcript from `get_messages`, then live `message_start` / `message_update` / `message_end`
- Prompt input (`prompt`, with `streamingBehavior` `followUp` or `steer` while a turn is running)
- Abort
- Tool cards from `tool_execution_start` / `update` / `end`
- Blocking extension dialogs (`confirm`, `select`, `input`, `editor`) so a permission prompt does not stall the pipe
- Engine/args/cwd as full-width fields, args one per line (paths with spaces stay one argument)
- Startup failures in the transcript, plus a diagnostics buffer (stderr, last invocation, last error) with copy

Out of scope on purpose: session picker, model picker chrome, themes as CSS tokens, custom extension UI, packaging/CI, host capability handshake.

## Run

From a source checkout, after `npm ci --ignore-scripts`:

```bash
cd apps/desktop/src-tauri
cargo run
```

Or, with the Tauri CLI:

```bash
cargo install tauri-cli --locked --version '^2'
cd apps/desktop/src-tauri
cargo tauri dev
```

Linux needs the usual Tauri WebKit/GTK dev packages. macOS and Windows use the platform webview.

In the window, **Source** chooses live Atomic or a fixture scenario (`stream`, `tool`, `confirm`, `select`, `abort`). Start the engine, then send a prompt. While a turn is running, **Follow-up** queues until idle and **Steer** queues a mid-turn correction. **Abort** cuts the fixture's slow stream.

Override the live engine with `ATOMIC_DESKTOP_ENGINE`, for example:

```bash
ATOMIC_DESKTOP_ENGINE="atomic --mode rpc --no-session" cargo run
```

`--mode rpc` is added only when the program looks like Atomic (`atomic`, `cli.ts`, `cli.js`, or a `coding-agent` CLI path). The fixture is `node` plus a script; do not append `--mode rpc` there. The host writes JSONL with LF only, including on Windows.

JSONL framing and fixture-path tests (no GUI):

```bash
cd apps/desktop/src-tauri
cargo test
```

Fixture and session assembler (no GUI):

```bash
node --test apps/desktop/src/session.test.mjs apps/desktop/fixtures/mock-rpc-engine.test.mjs
```

## Protocol additions this host made obvious

See [PROTOCOL.md](./PROTOCOL.md) for the Phase 2 record. Each gap is: what the app tried, what failed cleanly, the smallest protocol change, and a test that would prove it.

Short list: host identity, `list_sessions`, cwd/open-folder, typed permission prompts, custom UI, theme tokens, auth open-URL, notify mapping, an optional RPC hello, and structured `engine_error` codes. None of those are implemented here.

What already worked without protocol changes: spawn, `get_state`, `get_messages`, `prompt`, streaming `text_delta`, tool lifecycle, abort, follow-up/steer queues, and the extension UI request/response dance.

## Suggested follow-up PRs

1. Keep this host compiling and documented; do not add it to required CI.
2. Propose the smallest RPC handshake that names host kind (`tui` | `rpc` | `gui`) once a maintainer agrees the field list.
3. Add `list_sessions` (and maybe recents metadata) before any desktop session switcher.
4. Only then talk packaging, code signing, and a real settings UI.

See also [Desktop host (experimental)](../../packages/coding-agent/docs/desktop.md) and [RPC mode](../../packages/coding-agent/docs/rpc.md).
