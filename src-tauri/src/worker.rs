//! Starts and supervises the Node worker sidecar.
//!
//! Protocol: the worker writes exactly one JSON line to stdout,
//! `{"type":"ready","port":N,"token":"..."}` (or `{"type":"fatal","message":"..."}`).
//! Closing the worker's stdin asks it to shut down cleanly.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::Manager;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const MAX_RESTARTS: usize = 5;
const RESTART_WINDOW: Duration = Duration::from_secs(600);

#[derive(Clone, Serialize)]
pub struct Endpoint {
    pub port: u16,
    pub token: String,
}

#[derive(Deserialize)]
struct Line {
    #[serde(rename = "type")]
    kind: String,
    port: Option<u16>,
    token: Option<String>,
    message: Option<String>,
}

pub struct Sidecar {
    pub node: PathBuf,
    pub script: PathBuf,
    pub dir: PathBuf,
}

/// Bundled resources first; in a debug build fall back to the repo's build/sidecar.
pub fn locate_sidecar(app: &tauri::AppHandle) -> Sidecar {
    let mut candidates = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("sidecar"));
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("build").join("sidecar"));
    let dir = candidates
        .iter()
        .find(|d| d.join("worker.cjs").exists())
        .cloned()
        .unwrap_or_else(|| candidates[0].clone());
    Sidecar { node: dir.join("node.exe"), script: dir.join("worker.cjs"), dir }
}

#[derive(Default)]
struct State {
    endpoint: Option<Endpoint>,
    error: Option<String>,
    child: Option<Child>,
    stderr_tail: VecDeque<String>,
    shutting_down: bool,
}

#[derive(Clone)]
pub struct WorkerSupervisor {
    sidecar: Arc<Sidecar>,
    state: Arc<Mutex<State>>,
}

impl WorkerSupervisor {
    pub fn new(sidecar: Sidecar) -> Self {
        Self { sidecar: Arc::new(sidecar), state: Arc::new(Mutex::new(State::default())) }
    }

    pub fn endpoint(&self) -> Result<Option<Endpoint>, String> {
        let st = self.state.lock().unwrap();
        if let Some(e) = &st.error {
            return Err(e.clone());
        }
        Ok(st.endpoint.clone())
    }

    pub fn start(&self) {
        let me = self.clone();
        thread::spawn(move || me.supervise());
    }

    fn supervise(&self) {
        let mut restarts: VecDeque<Instant> = VecDeque::new();
        loop {
            if let Err(e) = self.spawn_once() {
                self.state.lock().unwrap().error = Some(e);
                return;
            }
            // Wait for exit.
            let status = loop {
                thread::sleep(Duration::from_millis(500));
                let mut st = self.state.lock().unwrap();
                match st.child.as_mut().map(|c| c.try_wait()) {
                    Some(Ok(Some(s))) => break Some(s),
                    Some(Ok(None)) => continue,
                    _ => break None,
                }
            };
            let mut st = self.state.lock().unwrap();
            st.child = None;
            st.endpoint = None;
            if st.shutting_down {
                return;
            }
            let now = Instant::now();
            restarts.retain(|t| now.duration_since(*t) < RESTART_WINDOW);
            if restarts.len() >= MAX_RESTARTS || st.error.is_some() {
                let tail: Vec<String> = st.stderr_tail.iter().cloned().collect();
                if st.error.is_none() {
                    st.error = Some(format!(
                        "worker exited repeatedly ({:?}). Last output:\n{}",
                        status,
                        tail.join("\n")
                    ));
                }
                return;
            }
            restarts.push_back(now);
            drop(st);
            // Back off a little more after each crash.
            thread::sleep(Duration::from_secs(2 * restarts.len() as u64));
        }
    }

    fn spawn_once(&self) -> Result<(), String> {
        let sc = &self.sidecar;
        if !sc.script.exists() {
            return Err(format!("worker not found at {}", sc.script.display()));
        }
        let mut cmd = Command::new(&sc.node);
        cmd.arg(&sc.script)
            .current_dir(&sc.dir)
            .env("DCS_PARENT_PIPE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let mut child = cmd.spawn().map_err(|e| format!("cannot start worker: {e}"))?;

        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");
        let state = self.state.clone();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(l) = serde_json::from_str::<Line>(&line) {
                    let mut st = state.lock().unwrap();
                    match l.kind.as_str() {
                        "ready" => {
                            if let (Some(port), Some(token)) = (l.port, l.token) {
                                st.endpoint = Some(Endpoint { port, token });
                                st.error = None;
                            }
                        }
                        "fatal" => st.error = Some(l.message.unwrap_or_else(|| "worker failed".into())),
                        _ => {}
                    }
                }
            }
        });
        let state = self.state.clone();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let mut st = state.lock().unwrap();
                st.stderr_tail.push_back(line);
                if st.stderr_tail.len() > 40 {
                    st.stderr_tail.pop_front();
                }
            }
        });
        self.state.lock().unwrap().child = Some(child);
        Ok(())
    }

    /// Close stdin so the worker finishes its current write and closes the DB; kill it if it hangs.
    pub fn shutdown(&self) {
        let mut child = {
            let mut st = self.state.lock().unwrap();
            st.shutting_down = true;
            match st.child.take() {
                Some(c) => c,
                None => return,
            }
        };
        drop(child.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = child.try_wait() {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}
