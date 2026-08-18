# Desktop RPC protocol gaps

This is the Phase 2 record for the optional Tauri host in `apps/desktop`. It is not a protocol change. Each gap is something the host tried on the public `--mode rpc` JSONL surface, what failed without crashing the pipe, the smallest additive change that would close it, and a test that would prove the change.

The host still does not read `~/.atomic`. Session files, credentials, tools, and extensions stay in the engine.

What already works without protocol changes is recorded at the bottom so the gaps are not mistaken for a missing spawn/prompt path.

## Host identity

**Tried.** Bind extensions through an RPC session and look for a way to tell a desktop host from a CI embedder. `ctx.mode === "rpc"` and `ctx.hasUI === true` on both.

**Failed cleanly.** A GUI-aware extension cannot write `ctx.ui.hostInfo.kind === "gui"` because that field does not exist. Custom UI stays `undefined`. The host cannot advertise itself without inventing a private command.

**Smallest protocol change.** Additive handshake on the existing RPC, for example `get_host_info` / `hello` with `{ kind: "tui" | "rpc" | "gui", app?: string }`, mirrored onto `ctx.ui.hostInfo`. Do not add a new `--mode gui` that forks the engine.

**Test that would prove it.** An RPC client sends `get_host_info` (or the engine includes the same payload on the first `get_state`). A fixture extension reads `ctx.ui.hostInfo.kind === "gui"` only when the host declared it. `atomic --mode rpc` without a host still reports `rpc`.

## Session listing

**Tried.** Render a recents / open-session control. The only related command is `switch_session`, which takes a path.

**Failed cleanly.** There is no `list_sessions`. Building the list would mean reading `~/.atomic/agent/sessions` from the webview, which this host must not do.

**Smallest protocol change.** `list_sessions` returning paths plus whatever recents metadata the engine already has (name, mtime, cwd). The host then calls the existing `switch_session`.

**Test that would prove it.** RPC `list_sessions` in a temp `--session-dir` returns the files the engine wrote, with no host filesystem access in the client.

## Project folder / cwd

**Tried.** Change the cwd field in the engine bar and keep the window.

**Failed cleanly.** Cwd is fixed at spawn. "Open folder" today means kill and respawn, which drops the live session.

**Smallest protocol change.** `set_cwd` that either (a) keeps the window and starts a new session in the new directory, or (b) returns a structured error that says a restart is required. Either is better than the host guessing.

**Test that would prove it.** After `set_cwd`, `get_state` reports the new directory (or the error names a restart). A follow-up `prompt` does not run in the old cwd.

## Typed permission prompts

**Tried.** Render Allow/Deny from `extension_ui_request` (`confirm` / `select`) using the title and option strings.

**Failed cleanly.** The pipe does not stall: the PoC dialog unblocks `confirm` and `select`. The host still cannot tell a tool-permission prompt from "clear the session?" without parsing copy. There is no `toolName`, `command`, or `permissionKind` field.

**Smallest protocol change.** Optional fields on dialog requests, for example `kind: "tool_permission"` plus `toolName`. Existing `confirm`/`select` stay valid.

**Test that would prove it.** A bash permission prompt arrives as `extension_ui_request` with `kind: "tool_permission"` and `toolName: "bash"`. A generic confirm does not carry that kind. The host can render Allow/Deny without reading `title`.

## Custom tool UI

**Tried.** Render a basic tool card from `tool_execution_start` / `update` / `end`. Ask the engine for `ctx.ui.custom()`.

**Failed cleanly.** Structured tool events are enough for name, args, and output. `custom()` is `undefined` over RPC. ANSI frames from the interactive-engine painter are not a webview protocol.

**Smallest protocol change.** A web-oriented custom-UI payload (JSON or HTML) on a new event or an `extension_ui_request` method, not a TUI paint dump.

**Test that would prove it.** An extension that calls `custom()` in RPC mode emits a host-visible request the webview can render, and a response round-trip does not stall the pipe.

## Theme tokens

**Tried.** Match the TUI theme in CSS.

**Failed cleanly.** RPC has no palette export. `getAllThemes()` is `[]`, `getTheme()` is `undefined`. The PoC hardcodes Catppuccin Mocha from `DESIGN.md`.

**Smallest protocol change.** `get_theme` returning CSS variables (or the existing theme JSON plus a documented token map). Optional `theme_changed` event.

**Test that would prove it.** `get_theme` after `--theme` (or `set_theme` if it is promoted) returns the same token names a host stylesheet can apply. A second call after a theme change returns the new values.

## Auth / open-URL

**Tried.** Prompt on a live engine with no API key. Use `login_provider` only as a documented command; this PoC has no login chrome.

**Failed cleanly.** `prompt` returns a correlated configuration error before any model events. That is usable as a transcript error. OAuth device codes and "open this URL" still have no host-visible event, so the desktop app cannot open a browser for the user.

**Smallest protocol change.** An `auth_challenge` (or extension UI `open_url`) event with the URL and a short user code when the engine wants a browser. Existing `login_provider` can keep doing the work.

**Test that would prove it.** `login_provider` for a subscription provider emits a host-visible URL before it blocks. The host does not read credential files. Completing login then allows `prompt`.

## Native notifications / window title

**Tried.** Honor `setTitle` / `notify` as fire-and-forget `extension_ui_request`s. Title updates the session label; notify updates the hint.

**Failed cleanly.** There is no native notification primitive and no standard urgency field. Ignoring `notify` is valid, so a host that wants OS notifications has to invent the mapping.

**Smallest protocol change.** Optional `level` / `body` fields on `notify`, or a documented statement that hosts may map `notify` to the OS. Title is already enough.

**Test that would prove it.** A `notify` request includes `body` and `level`. A host test asserts it can render those fields without parsing `message`.

## Ready / hello frame

**Tried.** After spawn, send `get_state` and wait up to 8s. Copy stderr if the child is not an RPC engine.

**Failed cleanly.** Public RPC has no hello record. A non-RPC child (or a hang) surfaces only as a timeout plus unstructured stderr. Isolation frames (`engine_ready`, `engine_bound`) are TUI compositor details and are ignored on purpose.

**Smallest protocol change.** Optional first-line `rpc_hello` `{ protocol: "atomic-rpc", version }` before any command. Hosts that do not wait for it still send `get_state` as today.

**Test that would prove it.** `atomic --mode rpc` writes `rpc_hello` as the first stdout line. The desktop fixture does the same. A host can fail fast when the first line is not JSONL RPC.

## Structured engine errors on stderr

**Tried.** Show spawn failures in the transcript. Keep a diagnostics buffer of stderr (missing native bindings, loader errors) and a copy button.

**Failed cleanly.** The pipe stays up or the process exits. The useful text is unstructured stderr. The host cannot classify "missing natives" vs "no API key" without scraping.

**Smallest protocol change.** Optional `engine_error` events with a stable `code` (`missing_native`, `invalid_config`, …) in addition to the existing prompt `response.error`. Stderr can stay for humans.

**Test that would prove it.** Starting without a required native binding emits `engine_error` with `code: "missing_native"` on stdout JSONL. The host test asserts on `code`, not on the log line.

## What already worked (not gaps)

These were proven on the public protocol, using the Node fixture in `apps/desktop/fixtures/mock-rpc-engine.mjs` when a live model is not configured:

| Action | Proof |
| --- | --- |
| Spawn + `get_state` / `get_messages` | Live CLI or fixture; session id and model pill |
| Streaming assistant text | Fixture `stream` (`text_delta` → `pong`); live path is the same events |
| Tool card | Fixture `tool` (`tool_execution_start` / `update` / `end` for `bash`) |
| Abort | Fixture `abort` (`stopReason: "aborted"`) |
| Follow-up / steer while running | `prompt` + `streamingBehavior`, or `steer` / `follow_up`; `queue_update` |
| Confirm / select dialogs | Fixture `confirm` / `select`; host `extension_ui_response` unblocks the pipe |

A live engine without credentials still fails `prompt` with a correlated error rather than hanging. That is protocol working, not a gap. The fixture exists so streaming, tools, abort, and dialogs can be proven without an API key. When a provider key is in the engine environment, `node apps/desktop/scripts/live-rpc-smoke.mjs` is the headless live-streaming check.

JSONL framing (LF only, optional trailing CR, no Unicode-separator splits) is covered by `cargo test` in `apps/desktop/src-tauri`.
