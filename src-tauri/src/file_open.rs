//! OS/CLI requests are delivered to one document window and acknowledged only
//! after navigation succeeds. A canceled draft prompt leaves the request retryable.
use serde::Serialize;
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Emitter, Manager, State};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub id: u64,
    pub path: Option<String>,
    pub error: Option<String>,
    target: String,
}
#[derive(Default)]
struct Queue {
    next: u64,
    requests: VecDeque<Request>,
}
#[derive(Default)]
pub struct FileOpenQueue(Mutex<Queue>);
impl FileOpenQueue {
    fn enqueue(
        &self,
        values: impl IntoIterator<Item = PathBuf>,
        target: &str,
    ) -> Result<(), String> {
        let mut queue = self.0.lock().map_err(|_| "file-open queue lock")?;
        for value in values.into_iter().take(65) {
            if queue.requests.len() >= 64 {
                return Err(
                    "File-open queue is full; retry after resolving pending requests".into(),
                );
            }
            let checked = validate(&value);
            if checked
                .as_ref()
                .is_ok_and(|path| queue.requests.iter().any(|r| r.path.as_ref() == Some(path)))
            {
                continue;
            }
            queue.next += 1;
            let id = queue.next;
            let (path, error) = match checked {
                Ok(path) => (Some(path), None),
                Err(error) => (None, Some(error)),
            };
            queue.requests.push_back(Request {
                id,
                path,
                error,
                target: target.into(),
            });
        }
        Ok(())
    }
    fn next(&self, window: &str) -> Option<Request> {
        self.0
            .lock()
            .ok()?
            .requests
            .iter()
            .find(|r| r.target == window)
            .cloned()
    }
    fn acknowledge(&self, window: &str, id: u64) -> Result<(), String> {
        let mut queue = self.0.lock().map_err(|_| "file-open queue lock")?;
        let index = queue
            .requests
            .iter()
            .position(|r| r.id == id && r.target == window)
            .ok_or("File-open request is no longer owned by this window")?;
        queue.requests.remove(index);
        Ok(())
    }
    pub fn retarget(&self, old: &str, target: &str) {
        if let Ok(mut queue) = self.0.lock() {
            for request in &mut queue.requests {
                if request.target == old {
                    request.target = target.into();
                }
            }
        }
    }
}
fn validate(path: &Path) -> Result<String, String> {
    if !path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            ["md", "markdown", "txt"]
                .iter()
                .any(|allowed| ext.eq_ignore_ascii_case(allowed))
        })
    {
        return Err(format!(
            "Only Markdown/text files can be opened: {}",
            path.display()
        ));
    }
    let path = path
        .canonicalize()
        .map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
    if !path.is_file() {
        return Err(format!("Not a regular file: {}", path.display()));
    }
    path.to_str()
        .map(String::from)
        .ok_or("File path is not valid Unicode".into())
}
/// AppImage's launcher changes cwd; its runtime preserves the caller's cwd in OWD.
/// Select this only for an actual AppImage environment, never a normal install.
#[cfg(target_os = "linux")]
pub fn launch_directory(cwd: &Path, appimage: bool, original: Option<PathBuf>) -> PathBuf {
    original
        .filter(|path| appimage && path.is_absolute() && path.is_dir())
        .unwrap_or_else(|| cwd.to_path_buf())
}

/// Extract-and-run can omit OWD. Its waiting runtime parent still owns the
/// launch cwd. Trust that fallback only if /proc identifies the exact AppImage.
#[cfg(target_os = "linux")]
pub fn appimage_origin() -> Option<PathBuf> {
    let image = PathBuf::from(std::env::var_os("APPIMAGE")?);
    if let Some(original) = std::env::var_os("OWD")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.is_dir())
    {
        return Some(original);
    }
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let parent = parent_pid(&status)?;
    let process = PathBuf::from(format!("/proc/{parent}"));
    if std::fs::read_link(process.join("exe"))
        .ok()?
        .canonicalize()
        .ok()?
        != image.canonicalize().ok()?
    {
        return None;
    }
    std::fs::read_link(process.join("cwd")).ok()
}
#[cfg(target_os = "linux")]
fn parent_pid(status: &str) -> Option<u32> {
    status
        .lines()
        .find_map(|line| line.strip_prefix("PPid:")?.trim().parse().ok())
        .filter(|pid| *pid > 0)
}

pub fn arguments(args: impl IntoIterator<Item = String>, cwd: &Path) -> Vec<PathBuf> {
    let mut literal = false;
    args.into_iter()
        .skip(1)
        .filter_map(|arg| {
            if !literal && arg == "--" {
                literal = true;
                return None;
            }
            if !literal && arg.starts_with('-') {
                return None;
            }
            if arg.len() > 8192 || arg.contains('\0') {
                return None;
            }
            let path = if arg.starts_with("file:") {
                tauri::Url::parse(&arg).ok()?.to_file_path().ok()?
            } else {
                PathBuf::from(arg)
            };
            Some(if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            })
        })
        .take(65)
        .collect()
}
pub fn is_document_window(label: &str) -> bool {
    label == "main" || label == "window" || label.starts_with("window-")
}
fn target(app: &tauri::AppHandle) -> Result<String, String> {
    let mut windows: Vec<_> = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| is_document_window(label))
        .collect();
    windows.sort_by_key(|(label, w)| (!w.is_focused().unwrap_or(false), label.clone()));
    if let Some((label, _)) = windows.first() {
        return Ok(label.clone());
    }
    let label = format!(
        "window-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
    );
    tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::App("index.html".into()))
        .title("Marquellium")
        .inner_size(1100.0, 750.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(label)
}
pub fn deliver(app: &tauri::AppHandle, paths: Vec<PathBuf>) -> Result<(), String> {
    let label = target(app)?;
    app.state::<FileOpenQueue>().enqueue(paths, &label)?;
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        window
            .emit_to(tauri::EventTarget::window(&label), "file-open-pending", ())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub fn window_destroyed(app: &tauri::AppHandle, old: &str) {
    let mut labels: Vec<_> = app
        .webview_windows()
        .keys()
        .filter(|label| label.as_str() != old && is_document_window(label))
        .cloned()
        .collect();
    labels.sort();
    let label = labels.first().map(String::as_str).unwrap_or("main");
    app.state::<FileOpenQueue>().retarget(old, label);
    let _ = app.emit_to(tauri::EventTarget::window(label), "file-open-pending", ());
}
pub fn startup(queue: &FileOpenQueue) -> Result<(), String> {
    queue.enqueue(
        arguments(
            std::env::args(),
            &std::env::current_dir().map_err(|e| e.to_string())?,
        ),
        "main",
    )
}
#[tauri::command]
pub fn file_open_next(
    window: tauri::Window,
    queue: State<'_, FileOpenQueue>,
    lifecycle: State<'_, crate::lifecycle::Lifecycle>,
) -> Option<Request> {
    if lifecycle.is_active() || !is_document_window(window.label()) {
        None
    } else {
        queue.next(window.label())
    }
}
#[tauri::command]
pub fn file_open_ack(
    window: tauri::Window,
    queue: State<'_, FileOpenQueue>,
    id: u64,
) -> Result<(), String> {
    queue.acknowledge(window.label(), id)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "linux")]
    #[test]
    fn proc_parent_requires_an_explicit_positive_pid() {
        assert_eq!(parent_pid("Name: app\nPPid:\t123\n"), Some(123));
        for invalid in ["Pid: 123", "PPid: 0", "PPid: -1", "PPid: malformed"] {
            assert_eq!(parent_pid(invalid), None);
        }
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn appimage_origin_is_used_only_when_absolute_existing_and_appimage_scoped() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = Path::new("/launcher");
        assert_eq!(
            launch_directory(cwd, true, Some(dir.path().into())),
            dir.path()
        );
        assert_eq!(launch_directory(cwd, false, Some(dir.path().into())), cwd);
        assert_eq!(launch_directory(cwd, true, Some("relative".into())), cwd);
        assert_eq!(
            launch_directory(cwd, true, Some(dir.path().join("missing"))),
            cwd
        );
    }
    #[test]
    fn file_urls_decode_spaces_and_unicode_without_using_sender_directory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note 東京 space.md");
        let url = tauri::Url::from_file_path(&path).unwrap();
        assert_eq!(
            arguments(["app".into(), url.to_string()], Path::new("other")),
            vec![path]
        );
        #[cfg(unix)]
        assert!(arguments(
            ["app".into(), "file://remote.invalid/doc.md".into()],
            Path::new("other")
        )
        .is_empty());
    }
    #[test]
    fn arguments_resolve_against_sender_and_allow_literal_dash_names() {
        let cwd = Path::new("sender");
        let got = arguments(
            ["app", "--ignored", "note space.md", "--", "-note.md"].map(String::from),
            cwd,
        );
        assert_eq!(got, vec![cwd.join("note space.md"), cwd.join("-note.md")]);
        assert!(!is_document_window("print-1"));
        assert!(!is_document_window("visual-1"));
        assert!(is_document_window("window-1"));
    }
    #[test]
    fn one_window_owns_retryable_deduplicated_requests_until_acknowledgment() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("東京.MD");
        std::fs::write(&path, "original").unwrap();
        let q = FileOpenQueue::default();
        q.enqueue([path.clone(), path.clone()], "a").unwrap();
        let r = q.next("a").unwrap();
        assert!(q.next("b").is_none());
        assert_eq!(q.next("a").unwrap().id, r.id);
        assert!(q.acknowledge("b", r.id).is_err());
        q.retarget("a", "b");
        assert!(q.next("a").is_none());
        q.acknowledge("b", r.id).unwrap();
        assert!(q.next("b").is_none());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "original");
    }
    #[test]
    fn invalid_or_missing_files_become_visible_errors_and_queue_is_bounded() {
        let q = FileOpenQueue::default();
        q.enqueue(
            [PathBuf::from("missing.md"), PathBuf::from("script.exe")],
            "main",
        )
        .unwrap();
        assert!(q.next("main").unwrap().error.is_some());
        assert!(q
            .enqueue(
                (0..65).map(|n| PathBuf::from(format!("missing-{n}.md"))),
                "main"
            )
            .is_err());
    }
}
