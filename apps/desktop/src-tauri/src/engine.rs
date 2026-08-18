use std::{env, path::PathBuf, process::Stdio};

use serde::{Deserialize, Serialize};
use tokio::{
	io::{AsyncReadExt, AsyncWriteExt},
	process::Command,
	sync::mpsc,
};

use crate::jsonl::{JsonlDecoder, serialize_json_line};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EngineInvocation {
	pub program: String,
	pub args: Vec<String>,
	pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EngineStatus {
	pub running: bool,
	pub pid: Option<u32>,
	pub program: Option<String>,
}

pub struct LiveEngine {
	stdin: tokio::process::ChildStdin,
	pid: Option<u32>,
	program: String,
	kill: Option<mpsc::Sender<()>>,
}

pub enum EngineOutput {
	Stdout(String),
	Stderr(String),
	Exited { code: Option<i32> },
}

impl LiveEngine {
	pub fn pid(&self) -> Option<u32> {
		self.pid
	}

	pub fn program(&self) -> &str {
		&self.program
	}

	pub async fn send_value(&mut self, value: &serde_json::Value) -> Result<(), String> {
		let bytes = serialize_json_line(value).map_err(|error| error.to_string())?;
		self
			.stdin
			.write_all(&bytes)
			.await
			.map_err(|error| format!("failed to write RPC command: {error}"))?;
		self.stdin.flush().await.map_err(|error| format!("failed to flush RPC command: {error}"))
	}

	pub async fn kill(&mut self) -> Result<(), String> {
		if let Some(kill) = self.kill.take() {
			kill.send(()).await.map_err(|_| "engine is already stopping".to_string())?;
		}
		Ok(())
	}
}

pub fn default_engine_invocation() -> EngineInvocation {
	if let Ok(raw) = env::var("ATOMIC_DESKTOP_ENGINE") {
		let trimmed = raw.trim();
		if !trimmed.is_empty() {
			return parse_invocation(trimmed, env::current_dir().ok());
		}
	}

	if let Some(repo) = discover_repo_root() {
		let source_cli = repo.join("packages/coding-agent/src/cli.ts");
		let dist_cli = repo.join("packages/coding-agent/dist/cli.js");
		if source_cli.is_file() {
			if let Some(bun) = find_on_path("bun") {
				let mut invocation = EngineInvocation {
					program: bun.display().to_string(),
					args: vec![
						source_cli.display().to_string(),
						"--mode".to_string(),
						"rpc".to_string(),
					],
					cwd: Some(repo.display().to_string()),
				};
				apply_extra_engine_args(&mut invocation.args);
				return invocation;
			}
		}
		if dist_cli.is_file() {
			if let Some(node) = find_on_path("node") {
				let mut invocation = EngineInvocation {
					program: node.display().to_string(),
					args: vec![dist_cli.display().to_string(), "--mode".to_string(), "rpc".to_string()],
					cwd: Some(repo.display().to_string()),
				};
				apply_extra_engine_args(&mut invocation.args);
				return invocation;
			}
		}
	}

	let mut invocation = EngineInvocation {
		program: find_on_path("atomic")
			.map(|path| path.display().to_string())
			.unwrap_or_else(|| "atomic".to_string()),
		args: vec!["--mode".to_string(), "rpc".to_string()],
		cwd: env::current_dir().ok().map(|path| path.display().to_string()),
	};
	apply_extra_engine_args(&mut invocation.args);
	invocation
}

pub fn parse_invocation(raw: &str, cwd: Option<PathBuf>) -> EngineInvocation {
	let tokens = tokenize(raw);
	let (program, args) = tokens.split_first().map_or_else(
		|| ("atomic".to_string(), Vec::new()),
		|(program, rest)| (program.clone(), rest.to_vec()),
	);
	let mut args = args;
	ensure_rpc_mode(&mut args);
	EngineInvocation { program, args, cwd: cwd.map(|path| path.display().to_string()) }
}

pub fn ensure_rpc_mode(args: &mut Vec<String>) {
	let has_rpc = args.windows(2).any(|window| window[0] == "--mode" && window[1] == "rpc")
		|| args.iter().any(|arg| arg == "--mode=rpc");
	if !has_rpc {
		args.push("--mode".to_string());
		args.push("rpc".to_string());
	}
}

pub fn append_arg_tokens(args: &mut Vec<String>, raw: &str) {
	for token in tokenize(raw) {
		if !token.is_empty() {
			args.push(token);
		}
	}
}

fn apply_extra_engine_args(args: &mut Vec<String>) {
	if let Ok(raw) = env::var("ATOMIC_DESKTOP_ENGINE_ARGS") {
		append_arg_tokens(args, &raw);
	}
	ensure_rpc_mode(args);
}

pub async fn spawn_engine(
	invocation: EngineInvocation,
	output: mpsc::UnboundedSender<EngineOutput>,
) -> Result<LiveEngine, String> {
	if invocation.program.trim().is_empty() {
		return Err("engine program is empty".to_string());
	}

	let mut command = Command::new(&invocation.program);
	command
		.args(&invocation.args)
		.stdin(Stdio::piped())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.kill_on_drop(true);
	if let Some(cwd) = invocation.cwd.as_deref().filter(|value| !value.is_empty()) {
		command.current_dir(cwd);
	}

	let mut child = command.spawn().map_err(|error| {
		format!(
			"failed to start `{}`: {error}. Set ATOMIC_DESKTOP_ENGINE or put `atomic` on PATH.",
			invocation.program
		)
	})?;
	let stdin = child.stdin.take().ok_or_else(|| "engine stdin was not piped".to_string())?;
	let mut stdout = child.stdout.take().ok_or_else(|| "engine stdout was not piped".to_string())?;
	let mut stderr = child.stderr.take().ok_or_else(|| "engine stderr was not piped".to_string())?;
	let pid = child.id();

	let stdout_tx = output.clone();
	tokio::spawn(async move {
		let mut buf = vec![0_u8; 16 * 1024];
		let mut decoder = JsonlDecoder::new();
		loop {
			match stdout.read(&mut buf).await {
				Ok(0) => break,
				Ok(n) => {
					for frame in decoder.push(&buf[..n]) {
						if stdout_tx.send(EngineOutput::Stdout(frame)).is_err() {
							return;
						}
					}
				},
				Err(_) => break,
			}
		}
		if let Some(rest) = decoder.finish() {
			if !rest.is_empty() {
				let _ = stdout_tx.send(EngineOutput::Stdout(rest));
			}
		}
	});

	let stderr_tx = output.clone();
	tokio::spawn(async move {
		let mut buf = vec![0_u8; 8 * 1024];
		loop {
			match stderr.read(&mut buf).await {
				Ok(0) => break,
				Ok(n) => {
					let text = String::from_utf8_lossy(&buf[..n]).into_owned();
					if stderr_tx.send(EngineOutput::Stderr(text)).is_err() {
						return;
					}
				},
				Err(_) => break,
			}
		}
	});

	let (kill_tx, mut kill_rx) = mpsc::channel(1);
	let wait_tx = output;
	tokio::spawn(async move {
		let status = tokio::select! {
			status = child.wait() => status,
			_ = kill_rx.recv() => {
				let _ = child.kill().await;
				child.wait().await
			}
		};
		let code = status.ok().and_then(|exit| exit.code());
		let _ = wait_tx.send(EngineOutput::Exited { code });
	});

	Ok(LiveEngine { stdin, pid, program: invocation.program, kill: Some(kill_tx) })
}

fn discover_repo_root() -> Option<PathBuf> {
	let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
	let mut candidate = manifest.as_path();
	for _ in 0..4 {
		candidate = candidate.parent()?;
		if candidate.join("packages/coding-agent").is_dir() {
			return Some(candidate.to_path_buf());
		}
	}
	None
}

fn find_on_path(name: &str) -> Option<PathBuf> {
	let file_name = if cfg!(windows) && !name.ends_with(".exe") {
		format!("{name}.exe")
	} else {
		name.to_string()
	};
	env::var_os("PATH").and_then(|paths| {
		env::split_paths(&paths).find_map(|dir| {
			let path = dir.join(&file_name);
			path.is_file().then_some(path)
		})
	})
}

fn tokenize(raw: &str) -> Vec<String> {
	let mut tokens = Vec::new();
	let mut current = String::new();
	let mut chars = raw.chars();
	let mut quote: Option<char> = None;
	while let Some(ch) = chars.next() {
		match (quote, ch) {
			(None, '"') | (None, '\'') => quote = Some(ch),
			(Some(q), ch) if ch == q => quote = None,
			(None, ch) if ch.is_whitespace() => {
				if !current.is_empty() {
					tokens.push(std::mem::take(&mut current));
				}
			},
			(_, '\\') if quote == Some('"') => {
				if let Some(escaped) = chars.next() {
					current.push(escaped);
				}
			},
			(_, ch) => current.push(ch),
		}
	}
	if !current.is_empty() {
		tokens.push(current);
	}
	tokens
}

#[cfg(test)]
mod tests {
	use super::{
		EngineOutput, append_arg_tokens, default_engine_invocation, ensure_rpc_mode,
		parse_invocation, spawn_engine,
	};
	use serde_json::json;
	use std::env;
	use tokio::sync::mpsc;

	#[test]
	fn appends_rpc_mode_when_missing() {
		let mut args = vec!["--no-session".to_string()];
		ensure_rpc_mode(&mut args);
		assert_eq!(args, ["--no-session", "--mode", "rpc"]);
	}

	#[test]
	fn leaves_existing_rpc_mode_in_place() {
		let mut args = vec!["--mode".to_string(), "rpc".to_string(), "--no-session".to_string()];
		ensure_rpc_mode(&mut args);
		assert_eq!(args, ["--mode", "rpc", "--no-session"]);
	}

	#[test]
	fn parse_invocation_tokenizes_quotes() {
		let invocation = parse_invocation(r#"/usr/bin/atomic --mode rpc --name "desk poc""#, None);
		assert_eq!(invocation.program, "/usr/bin/atomic");
		assert_eq!(invocation.args, ["--mode", "rpc", "--name", "desk poc"]);
	}

	#[test]
	fn extra_arg_tokens_keep_quoted_paths() {
		let mut args = vec!["--mode".to_string(), "rpc".to_string()];
		append_arg_tokens(&mut args, r#"--no-session --cwd "/tmp/My Project""#);
		assert_eq!(args, ["--mode", "rpc", "--no-session", "--cwd", "/tmp/My Project"]);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn live_rpc_get_state_when_anthropic_key_present() {
		let key = env::var("ANTHROPIC_API_KEY").unwrap_or_default();
		if key.trim().is_empty() {
			eprintln!("skip live_rpc_get_state_when_anthropic_key_present: ANTHROPIC_API_KEY unset");
			return;
		}

		if let Ok(home) = env::var("HOME") {
			let bun_dir = std::path::PathBuf::from(home).join(".bun/bin");
			if bun_dir.join("bun").is_file() {
				let path = env::var("PATH").unwrap_or_default();
				let prefix = bun_dir.display().to_string();
				if !path.split(':').any(|entry| entry == prefix) {
					env::set_var("PATH", format!("{prefix}:{path}"));
				}
			}
		}

		let mut invocation = default_engine_invocation();
		append_arg_tokens(
			&mut invocation.args,
			"--no-session --no-extensions --provider anthropic --model haiku",
		);
		ensure_rpc_mode(&mut invocation.args);

		let (tx, mut rx) = mpsc::unbounded_channel();
		let mut engine = spawn_engine(invocation, tx).await.expect("spawn live engine");
		engine
			.send_value(&json!({ "id": "req-1", "type": "get_state" }))
			.await
			.expect("send get_state");

		let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(20);
		let mut saw = false;
		while tokio::time::Instant::now() < deadline {
			match tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv()).await {
				Ok(Some(EngineOutput::Stdout(line))) => {
					let value: serde_json::Value = serde_json::from_str(&line).expect("json");
					if value["type"] == "response" && value["id"] == "req-1" {
						assert_eq!(value["success"], true);
						assert_eq!(value["command"], "get_state");
						assert_eq!(value["data"]["model"]["provider"], "anthropic");
						let model_id = value["data"]["model"]["id"].as_str().unwrap_or("");
						assert!(model_id.contains("haiku"), "unexpected model id {model_id}");
						saw = true;
						break;
					}
				},
				Ok(Some(EngineOutput::Exited { code })) => {
					panic!("engine exited before get_state ({code:?})");
				},
				Ok(Some(_)) => {},
				Ok(None) | Err(_) => break,
			}
		}
		let _ = engine.kill().await;
		assert!(saw, "did not receive get_state from the live engine");
	}
}
