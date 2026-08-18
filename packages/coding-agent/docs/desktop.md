---
title: "Desktop host"
description: "Experimental optional Tauri host that speaks Atomic RPC"
---

# Desktop host (experimental)

Atomic's default interface is the TUI. This repository also carries a small optional [Tauri](https://v2.tauri.app/) proof of concept that starts the existing engine and renders a basic session. It lives in `apps/desktop`, outside the npm workspace and outside the natives Cargo workspace.

The TUI does not depend on it. `atomic` still launches interactive mode on a TTY. Extensions still see `ctx.mode === "tui"` in that path.

## What it is for

Issue [#2352](https://github.com/bastani-inc/atomic/issues/2352) asked whether a desktop host belongs in this project. Maintainers preferred Tauri over Electron, and asked for a real host on the current protocol before any GUI capability handshake.

This proof of concept is that host:

1. Spawn `atomic --mode rpc` (or this checkout's CLI) with piped stdio.
2. Speak the documented JSONL RPC from [RPC mode](/rpc).
3. Render user/assistant text, streaming deltas, tool status, abort, queued follow-up/steer, and blocking extension dialogs.

It does not read credential or configuration files. The engine still owns sessions, tools, extensions, settings, models, trust, and authentication.

When a live model is not configured, the window's **Source** control can start a Node fixture (`apps/desktop/fixtures/mock-rpc-engine.mjs`) that speaks the same JSONL. That is how streaming, tool cards, abort, and confirm/select are proven without an API key. The fixture is not a substitute for Atomic.

## Run it

From a source checkout:

```bash
cd apps/desktop/src-tauri
cargo test
cargo run
```

Headless proofs (no GUI):

```bash
node --test apps/desktop/src/session.test.mjs apps/desktop/fixtures/mock-rpc-engine.test.mjs
```

`ATOMIC_DESKTOP_ENGINE` overrides the live child command. `--mode rpc` is added if the program looks like Atomic and the flag is missing. Details, Linux WebKit packages, and the Phase 2 protocol-gap record are in `apps/desktop/README.md` and `apps/desktop/PROTOCOL.md` at the repository root.

## What this does not change

- No GUI discriminator on `ExtensionContext` yet. A desktop RPC session still reports `mode: "rpc"`.
- No Electron or Tauri dependency in `@bastani/atomic`.
- No required CI job for the desktop crate.
