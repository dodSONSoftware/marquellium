//! Mermaid runs in a separate copy of this executable with no document commands.
//! Native deadlines/cancellation kill that process independently of its JS thread.
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const MAX_SOURCE_BYTES: usize = 16_384;
const MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
const PREFIX: &str = "MDV_PREVIEW_RESULT=";
const BUDGET: Duration = Duration::from_secs(6);
type Jobs = HashMap<String, (String, Arc<AtomicBool>)>;

#[derive(Default, Clone)]
pub struct PreviewService {
    jobs: Arc<Mutex<Jobs>>,
    active: Arc<AtomicUsize>,
}

impl PreviewService {
    pub fn cancel(&self, window: &str, id: Option<&str>) {
        if let Some((current, flag)) = self.jobs.lock().expect("preview jobs").get(window) {
            if id.is_none_or(|id| id == current) {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }
    async fn render(&self, window: String, id: String, source: String) -> Result<String, String> {
        if source.len() > MAX_SOURCE_BYTES || source.is_empty() || id.len() > 128 {
            return Err("preview input limit exceeded".into());
        }
        self.cancel(&window, None);
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        let mut active = self.active.load(Ordering::SeqCst);
        loop {
            if active >= 2 {
                return Err("preview capacity exhausted; retry".into());
            }
            match self.active.compare_exchange_weak(
                active,
                active + 1,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => break,
                Err(current) => active = current,
            }
        }
        struct Slot(Arc<AtomicUsize>);
        impl Drop for Slot {
            fn drop(&mut self) {
                self.0.fetch_sub(1, Ordering::SeqCst);
            }
        }
        let _slot = Slot(self.active.clone());
        let cancel = Arc::new(AtomicBool::new(false));
        self.jobs
            .lock()
            .expect("preview jobs")
            .insert(window.clone(), (id.clone(), cancel.clone()));
        let mut command = tokio::process::Command::new(executable);
        command.arg("--mermaid-preview-worker");
        let result = run_child(command, &source, cancel.clone(), BUDGET).await;
        let mut jobs = self.jobs.lock().expect("preview jobs");
        if jobs
            .get(&window)
            .is_some_and(|(_, flag)| Arc::ptr_eq(flag, &cancel))
        {
            jobs.remove(&window);
        }
        result
    }
}

async fn run_child(
    mut command: tokio::process::Command,
    source: &str,
    cancel: Arc<AtomicBool>,
    budget: Duration,
) -> Result<String, String> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|e| format!("preview worker launch failed: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("missing preview stdin")?;
    let stdout = child.stdout.take().ok_or("missing preview stdout")?;
    let input = serde_json::to_vec(source).map_err(|e| e.to_string())?;
    let work = async {
        stdin.write_all(&input).await.map_err(|e| e.to_string())?;
        drop(stdin);
        let read = async {
            let mut output = Vec::new();
            stdout
                .take((MAX_OUTPUT_BYTES + 1) as u64)
                .read_to_end(&mut output)
                .await
                .map_err(|e| e.to_string())?;
            if output.len() > MAX_OUTPUT_BYTES {
                return Err("preview output limit exceeded".into());
            }
            Ok(output)
        };
        let wait = async { child.wait().await.map_err(|e| e.to_string()) };
        let (output, status) = tokio::try_join!(read, wait)?;
        if !status.success() {
            return Err("preview worker failed".into());
        }
        let packet = String::from_utf8(output).map_err(|e| e.to_string())?;
        let line = packet
            .lines()
            .find_map(|line| line.strip_prefix(PREFIX))
            .ok_or("preview worker returned no result")?;
        let result: WorkerResult = serde_json::from_str(line).map_err(|e| e.to_string())?;
        if let Some(error) = result.error {
            return Err(error);
        }
        result
            .svg
            .filter(|svg| svg.len() <= 512 * 1024 && svg.contains("<svg"))
            .ok_or("invalid preview output".into())
    };
    let cancelled = async {
        loop {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    };
    let result = tokio::select! {
        result = work => result,
        _ = tokio::time::sleep(budget) => Err("preview timed out; worker terminated".into()),
        _ = cancelled => Err("preview cancelled; worker terminated".into()),
    };
    if result.is_err() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    result
}

#[tauri::command]
pub async fn previews_mermaid(
    service: State<'_, PreviewService>,
    window: tauri::Window,
    request_id: String,
    source: String,
) -> Result<String, String> {
    service
        .render(window.label().into(), request_id, source)
        .await
}
#[tauri::command]
pub fn previews_cancel(
    service: State<'_, PreviewService>,
    window: tauri::Window,
    request_id: String,
) {
    service.cancel(window.label(), Some(&request_id));
}

#[derive(Serialize, Deserialize)]
struct WorkerResult {
    svg: Option<String>,
    error: Option<String>,
}
#[tauri::command]
fn preview_input(source: State<'_, String>) -> String {
    source.inner().clone()
}
#[tauri::command]
fn preview_finish(app: tauri::AppHandle, result: WorkerResult) -> Result<(), String> {
    if result
        .svg
        .as_ref()
        .is_some_and(|svg| svg.len() > 512 * 1024)
        || result
            .error
            .as_ref()
            .is_some_and(|error| error.len() > 2048)
    {
        return Err("preview output limit exceeded".into());
    }
    println!(
        "{PREFIX}{}",
        serde_json::to_string(&result).map_err(|e| e.to_string())?
    );
    app.exit(0);
    Ok(())
}

pub fn run_worker() {
    use std::io::Read;
    let mut input = Vec::new();
    std::io::stdin()
        .take((MAX_SOURCE_BYTES * 2 + 1024) as u64)
        .read_to_end(&mut input)
        .expect("preview input");
    let source: String = serde_json::from_slice(&input).expect("preview JSON");
    assert!(source.len() <= MAX_SOURCE_BYTES, "preview input limit");
    let mut context = crate::app_context();
    context.config_mut().app.windows.clear();
    context.config_mut().app.security.csp = Some(tauri::utils::config::Csp::Policy("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'none'; connect-src 'self'; font-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'".into()));
    tauri::Builder::default()
        .manage(source)
        .invoke_handler(tauri::generate_handler![preview_input, preview_finish])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            tauri::WebviewWindowBuilder::new(
                app,
                "preview-worker",
                tauri::WebviewUrl::App("mermaid-preview.html".into()),
            )
            .visible(false)
            .incognito(true)
            .build()?;
            Ok(())
        })
        .run(context)
        .expect("preview worker");
}

/// Developer acceptance probe; uses the same process, DOM renderer and deadline.
pub fn check_from_stdin() {
    use std::io::Read;
    let mut source = String::new();
    std::io::stdin()
        .take((MAX_SOURCE_BYTES + 1) as u64)
        .read_to_string(&mut source)
        .expect("probe input");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("probe runtime");
    match runtime.block_on(PreviewService::default().render("probe".into(), "probe".into(), source))
    {
        Ok(svg) => println!(
            "{}",
            serde_json::json!({ "svgBytes": svg.len(), "hasSvg": svg.contains("<svg"), "hasShapes": svg.contains("<path") || svg.contains("<rect") })
        ),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(mode: &str) -> tokio::process::Command {
        let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--ignored",
                "--exact",
                "preview::tests::worker_fixture",
                "--nocapture",
            ])
            .env("MDV_PREVIEW_FIXTURE", mode);
        command
    }
    #[test]
    #[ignore]
    fn worker_fixture() {
        match std::env::var("MDV_PREVIEW_FIXTURE").as_deref() {
            Ok("hang") => loop {
                std::thread::sleep(Duration::from_millis(10));
            },
            Ok("large") => println!("{}", "X".repeat(MAX_OUTPUT_BYTES + 1)),
            _ => println!(
                "{PREFIX}{}",
                serde_json::to_string(&WorkerResult {
                    svg: Some("<svg></svg>".into()),
                    error: None
                })
                .unwrap()
            ),
        }
    }
    #[tokio::test]
    async fn child_success_is_bounded_and_decoded() {
        assert_eq!(
            run_child(
                fixture("ok"),
                "input",
                Arc::new(AtomicBool::new(false)),
                Duration::from_secs(2)
            )
            .await
            .unwrap(),
            "<svg></svg>"
        );
    }
    #[tokio::test]
    async fn native_timeout_kills_a_worker_that_never_returns() {
        let start = std::time::Instant::now();
        let result = run_child(
            fixture("hang"),
            "input",
            Arc::new(AtomicBool::new(false)),
            Duration::from_millis(100),
        )
        .await;
        assert!(result.unwrap_err().contains("timed out"));
        assert!(start.elapsed() < Duration::from_secs(2));
    }
    #[tokio::test]
    async fn cancellation_and_output_caps_are_enforced() {
        let flag = Arc::new(AtomicBool::new(false));
        let trigger = flag.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(30)).await;
            trigger.store(true, Ordering::Relaxed);
        });
        assert!(
            run_child(fixture("hang"), "input", flag, Duration::from_secs(2))
                .await
                .unwrap_err()
                .contains("cancelled")
        );
        assert!(run_child(
            fixture("large"),
            "input",
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(2)
        )
        .await
        .unwrap_err()
        .contains("output limit"));
    }

    #[test]
    fn cancellation_is_scoped_to_window_and_current_request() {
        let service = PreviewService::default();
        let a = Arc::new(AtomicBool::new(false));
        let b = Arc::new(AtomicBool::new(false));
        service
            .jobs
            .lock()
            .unwrap()
            .insert("a".into(), ("new".into(), a.clone()));
        service
            .jobs
            .lock()
            .unwrap()
            .insert("b".into(), ("other".into(), b.clone()));
        service.cancel("a", Some("old"));
        assert!(!a.load(Ordering::Relaxed));
        service.cancel("a", Some("new"));
        assert!(a.load(Ordering::Relaxed));
        assert!(!b.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn input_and_concurrency_budgets_reject_before_spawning() {
        let service = PreviewService::default();
        assert!(service
            .render("a".into(), "id".into(), "x".repeat(MAX_SOURCE_BYTES + 1))
            .await
            .unwrap_err()
            .contains("input"));
        service.active.store(2, Ordering::SeqCst);
        assert!(service
            .render("a".into(), "id".into(), "flowchart LR".into())
            .await
            .unwrap_err()
            .contains("capacity"));
        assert_eq!(service.active.load(Ordering::SeqCst), 2);
    }
}
