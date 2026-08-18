# Atomic desktop proof of concept

Optional Tauri host that starts the existing Atomic engine over `--mode rpc` and renders a basic session. It is not a replacement for the TUI, not on the default install path, and not part of `@bastani/atomic`.

This is the first slice described on [issue 2352](https://github.com/bastani-inc/atomic/issues/2352): a real host consuming the current protocol, so the protocol additions a GUI actually needs can be named from use rather than invented up front.

## Why this shape

Atomic already has a host/engine split. The public embed API is JSONL over stdin/stdout (`atomic --mode rpc`). The TUI uses that same child, plus a private isolation layer (`engine_ready` / `engine_bound` / remote paint). A first desktop host should speak the public RPC. The isolation frames are TUI compositor details; copying them would hide the gaps instead of exposing them.

Placement is `apps/desktop`, outside `packages/*` and outside the Rust natives workspace, so:

- `npm ci` and the published shrinkwrap stay unchanged
- `atomic` still starts the TUI by default
- Tauri, GTK, and WebKit are never required to test or extend the CLI

The webview does not read `~/.atomic` credential or settings files. It spawns the engine and talks JSONL. Session files, auth, tools, and extensions stay in the engine.

## What it renders

- Engine start/stop. Default command prefers this checkout's CLI (`bun packages/coding-agent/src/cli.ts --mode rpc`). Args are one token per line, so paths with spaces stay intact.
- Session transcript from `get_messages`, then live `message_start` / `message_update` / `message_end`
- Prompt input. While a turn is running, send is either `streamingBehavior: "followUp"` or `"steer"` (composer control). `queue_update` shows up in the hint.
- Abort, with `stopReason` `aborted` / `error` on the assistant bubble
- Tool cards from `tool_execution_start` / `update` / `end` (phase, args, output)
- Blocking extension dialogs (`confirm`, `select`, `input`, `editor`)
- Engine stderr, spawn errors, and exit codes in the transcript plus a copyable diagnostics panel

Out of scope on purpose: session picker, model picker chrome, themes as CSS tokens, custom extension UI, packaging/CI, host capability handshake. Those are written down in [PROTOCOL_GAPS.md](./PROTOCOL_GAPS.md) from what this host could not do cleanly.

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

Override the engine with `ATOMIC_DESKTOP_ENGINE`. Extra default tokens (still quoted the same way) can be appended with `ATOMIC_DESKTOP_ENGINE_ARGS`:

```bash
ATOMIC_DESKTOP_ENGINE="atomic --mode rpc --no-session" cargo run
ATOMIC_DESKTOP_ENGINE_ARGS='--no-extensions --provider anthropic --model haiku' cargo run
```

The host always ensures `--mode rpc` is present. It writes JSONL with LF only, including on Windows.

## Tests

JSONL framing and spawn argv (no GUI):

```bash
cd apps/desktop/src-tauri
cargo test
```

If `ANTHROPIC_API_KEY` is set, `cargo test` also runs a live `get_state` against this checkout's CLI and Anthropic Haiku. Without a key that test returns immediately.

Session assembler tests (documented RPC event shapes, no network) and live RPC tests (real Anthropic Haiku, skip if no key):

```bash
node --test apps/desktop/tests/session.test.mjs
node --test apps/desktop/tests/live-rpc.test.mjs
```

The live suite spawns `bun packages/coding-agent/src/cli.ts --mode rpc --no-session --no-extensions --provider anthropic --model haiku`, keeps stdin open until `agent_end`, and never logs secret values. Named budget: `LIVE_RPC_TIMEOUT_MS` (120s) in `tests/rpc-session.mjs`. There is no mock engine.

## Protocol additions this host made obvious

See [PROTOCOL_GAPS.md](./PROTOCOL_GAPS.md). Short version:

**Host identity.** RPC sessions bind extensions with `ctx.mode === "rpc"` and `ctx.hasUI === true`. This desktop host and a CI embedder look the same.

**Session listing.** `list_sessions` is not a command. Live test asserts that. A recents UI would otherwise read `~/.atomic/agent/sessions`, which this host must not do.

**Project folder.** Cwd is fixed at spawn. "Open folder" today means kill and respawn.

**Typed permission prompts.** Live bash with `--no-extensions` never emits `extension_ui_request`. Tool approval as a generic confirm/select is not Allow/Deny.

**Custom UI.** `ctx.ui.custom()` is TUI-only over RPC. Structured `tool_execution_*` events are enough for a basic tool card.

**Themes.** RPC has no palette export. This UI hardcodes Catppuccin Mocha from `DESIGN.md`.

**Auth.** `login_provider` exists. This host has no login chrome. Keys are inherited by the engine child; the webview does not read them.

What already worked without protocol changes, and is covered by the live tests when a key is present: spawn, `get_state`, `prompt`, a completed assistant turn (Haiku sometimes skips `text_delta` on a one-word reply; the assembler still handles deltas), bash tool lifecycle, abort, steer / `queue_update`.

## Suggested follow-up PRs

1. Keep this host compiling and documented; do not add it to required CI.
2. Propose the smallest RPC handshake that names host kind (`tui` | `rpc` | `gui`) once a maintainer agrees the field list.
3. Add `list_sessions` (and maybe recents metadata) before any desktop session switcher.
4. Only then talk packaging, code signing, and a real settings UI.

See also [Desktop host (experimental)](../../packages/coding-agent/docs/desktop.md) and [RPC mode](../../packages/coding-agent/docs/rpc.md).
