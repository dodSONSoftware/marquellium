#!/usr/bin/env python3
"""Native WebKitGTK smoke through Tauri's W3C driver; only disposable data.
Run under dbus-run-session + xvfb-run. Requires tauri-driver 2.1.0 and WebKitWebDriver.
No production test bridge or external Python packages.
"""
import argparse
import base64
import json
import os
import errno
import socket
import signal
import struct
import zlib
import hashlib
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
import subprocess
import tempfile
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError

parser = argparse.ArgumentParser()
parser.add_argument("binary", type=Path)
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--exports", action="store_true", help="Test native Linux export/print dialogs in the disposable Xvfb desktop")
parser.add_argument("--native-keys", action="store_true", help="Test GTK keyboard Quit using X11 input inside an isolated test desktop")
parser.add_argument("--trace-network", action="store_true", help="Trace native driver/app connect/send attempts using strace")
parser.add_argument("--offline", action="store_true", help="Require an isolated Linux namespace with no route to external networks")
args = parser.parse_args()
if (args.exports or args.native_keys) and not Path("/.dockerenv").is_file():
    parser.error("Native desktop input/export acceptance is restricted to a disposable Docker container")
args.output.mkdir(parents=True, exist_ok=True)
if args.offline:
    routes = Path("/proc/net/route").read_text().splitlines()
    if len(routes) != 1:
        raise AssertionError("Offline acceptance requires no external IPv4 routes; use Docker --network none")
    controls = []
    for family, destination in [(socket.AF_INET, ("1.1.1.1", 443)), (socket.AF_INET6, ("2606:4700:4700::1111", 443))]:
        with socket.socket(family, socket.SOCK_STREAM) as probe:
            probe.settimeout(2)
            try:
                probe.connect(destination)
            except OSError as error:
                if error.errno not in {errno.ENETUNREACH, errno.EHOSTUNREACH}:
                    raise AssertionError(f"Offline control was inconclusive: {error}") from error
                controls.append({"address": destination[0], "errno": error.errno, "outcome": "unreachable"})
            else:
                raise AssertionError("External networking is available; this is not an offline test")
    (args.output / "network-isolation.json").write_text(json.dumps({"ipv4Routes": routes, "controls": controls, "scope": "Native app functionality in a network-isolated Linux namespace; not a packet capture or proof of no attempted connections"}, indent=2))

workspace = Path(tempfile.mkdtemp(prefix="marquellium-m6-"))
if args.exports and Path("/output.pdf").exists():
    Path("/output.pdf").rename(workspace / "previous-native-output.pdf")
fixture = workspace / "notes 東京.md"
fixture.write_text("# Portable heading\n\n![local](pixel.png)\n\nMath: $x^2$\n\n```mermaid\nflowchart LR\n A[Start] --> B[Done]\n```\n\n| Item | Amount |\n| --- | ---: |\n| Alpha | 10 |\n", encoding="utf-8")
def png_chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
png = b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", struct.pack(">IIBBBBB", 32, 16, 8, 6, 0, 0, 0))
png += png_chunk(b"IDAT", zlib.compress((b"\0" + b"\x4d\x9f\xdc\xff" * 32) * 16)) + png_chunk(b"IEND", b"")
(workspace / "pixel.png").write_bytes(png)
source_hash = hashlib.sha256(fixture.read_bytes()).hexdigest()
second = workspace / "second note.md"
second.write_text("# Second file\n", encoding="utf-8")
if args.exports:
    os.environ["XDG_CURRENT_DESKTOP"] = "GNOME"
    subprocess.run(["dbus-update-activation-environment", "DISPLAY", "XAUTHORITY", "XDG_CURRENT_DESKTOP"], check=True, timeout=10)
env = dict(os.environ, MARKDOWN_VIEWER_DATA_DIR=str(workspace / "data"))
log = (args.output / "driver.log").open("w")
wm = subprocess.Popen(["openbox"], stdout=log, stderr=subprocess.STDOUT) if os.environ.get("DISPLAY") else None
driver_command = ["tauri-driver"]
if args.trace_network:
    driver_command = ["strace", "-f", "-s", "200", "-e", "trace=connect,sendto,sendmsg", "-o", str(args.output / "network.trace"), *driver_command]
driver = subprocess.Popen(driver_command, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
session = None
checks = []
completed = False

def call(method, path, body=None):
    request = Request("http://127.0.0.1:4444" + path, data=None if body is None else json.dumps(body).encode(), method=method, headers={"Content-Type": "application/json"})
    try:
        with urlopen(request, timeout=45) as response:
            value = json.load(response).get("value")
    except HTTPError as error:
        raise RuntimeError(error.read().decode()) from error
    if isinstance(value, dict) and "error" in value:
        raise RuntimeError(value)
    return value

def command(method, path, body=None):
    return call(method, "/session/" + session + path, body)

def script(source, *arguments):
    return command("POST", "/execute/sync", {"script": source, "args": list(arguments)})

def until(predicate, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(0.15)
    raise AssertionError("Timed out waiting for native UI")

def check(name, predicate):
    until(predicate)
    checks.append(name)
    print("PASS", name, flush=True)

def button(text):
    return script("const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===arguments[0]); if(b&&!b.disabled){b.click();return true}return false", text)

def owned_desktop_window(title=None):
    active = subprocess.check_output(["xdotool", "getactivewindow"], text=True).strip()
    name = subprocess.check_output(["xdotool", "getwindowname", active], text=True).strip()
    if title is not None and name != title: return False
    pid = subprocess.check_output(["xdotool", "getwindowpid", active], text=True).strip()
    process = Path("/proc") / pid
    entries = (process / "environ").read_bytes().split(b"\0")
    owned = ("MARKDOWN_VIEWER_DATA_DIR=" + str(workspace / "data")).encode() in entries
    portal = Path(os.readlink(process / "exe")).name in {"xdg-desktop-portal-gtk", "xdg-desktop-portal"}
    same_bus = ("DBUS_SESSION_BUS_ADDRESS=" + os.environ.get("DBUS_SESSION_BUS_ADDRESS", "")).encode() in entries
    if not owned and not (portal and same_bus):
        raise AssertionError("Refusing native input outside the disposable app/portal session")
    return active

def native_key(key):
    if not owned_desktop_window(): raise AssertionError("No owned native test window")
    subprocess.run(["xdotool", "key", "--clearmodifiers", key], check=True, timeout=10)

def native_save(path):
    until(lambda: owned_desktop_window("Export document"))
    native_key("ctrl+l")
    native_key("ctrl+a")
    subprocess.run(["xdotool", "type", "--clearmodifiers", "--delay", "1", str(path)], check=True, timeout=10)
    native_key("Return")
    until(lambda: path.is_file() or owned_desktop_window("Export document"))
    if not path.is_file():
        subprocess.run(["scrot", "-o", str(args.output / "native-save-dialog.png")], check=True, timeout=10)
        native_key("alt+s")
    until(path.is_file)


def ready_driver():
    try: return bool(call("GET", "/status"))
    except OSError: return False

try:
    until(lambda: driver.poll() is None and ready_driver(), 30)
    value = call("POST", "/session", {"capabilities": {"alwaysMatch": {"tauri:options": {"application": str(args.binary.resolve()), "args": [str(fixture)]}}}})
    session = value["sessionId"]
    check("cold CLI open with spaces and Unicode", lambda: script("return document.title.includes('notes 東京.md') && [...document.querySelectorAll('input')].some(i=>i.value==='Portable heading')"))
    until(lambda: button("Read"))
    check("relative local image loads", lambda: script("return [...document.querySelectorAll('.reader img')].some(i=>i.complete&&i.naturalWidth>0)"))
    check("KaTeX renders in native webview", lambda: script("return !!document.querySelector('.katex')"))
    check("Mermaid renders in native webview", lambda: script("return !!document.querySelector('svg')"))
    if args.exports:
        until(lambda: button("Export…"))
        until(lambda: button("Export HTML"))
        until(lambda: owned_desktop_window("Export document"))
        native_key("Escape")
        check("native HTML export cancellation returns without writing", lambda: script("return document.body.innerText.includes('Export canceled; no file written.')"))
        until(lambda: button("Export HTML"))
        html_path = workspace / "native-export.html"
        native_save(html_path)
        html = html_path.read_text()
        assert "Portable heading" in html and "Alpha" in html and "<script" not in html.lower() and "<math" in html and "data:image/" in html
        checks.append("native HTML export contains text, table, math and embedded images")
        until(lambda: button("Export DOCX"))
        docx_path = workspace / "native-export.docx"
        native_save(docx_path)
        with zipfile.ZipFile(docx_path) as archive:
            assert archive.testzip() is None
            for name in archive.namelist():
                if name.endswith((".xml", ".rels")): ET.fromstring(archive.read(name))
            text = archive.read("word/document.xml").decode()
            assert "Portable heading" in text and "Alpha" in text
        checks.append("native DOCX export passes independent ZIP/XML and content checks")
        for path in [html_path, docx_path]: (args.output / path.name).write_bytes(path.read_bytes())
        until(lambda: button("Export PDF"))
        document_window = command("GET", "/window")
        print_window = until(lambda: next((handle for handle in command("GET", "/window/handles") if handle != document_window), None))
        command("POST", "/window", {"handle": print_window})
        until(lambda: button("Print / Save PDF…"))
        until(lambda: owned_desktop_window("Print"))
        time.sleep(1)  # GTK discovers printers asynchronously after mapping the dialog.
        subprocess.run(["scrot", "-o", str(args.output / "native-print-dialog.png")], check=True, timeout=10)
        native_key("Escape")
        check("native print cancellation keeps the preview available", lambda: script("return document.body.innerText.includes('Print / Save PDF')"))
        until(lambda: button("Print / Save PDF…"))
        until(lambda: owned_desktop_window("Print"))
        time.sleep(1)
        subprocess.run(["scrot", "-o", str(args.output / "native-print-ready.png")], check=True, timeout=10)
        # In this printer-free Xvfb image, GTK lists only its virtual Print to
        # File row. Selecting it enables Print; no physical printer is present.
        print_dialog = owned_desktop_window("Print")
        subprocess.run(["xdotool", "mousemove", "--window", print_dialog, "100", "85", "click", "1"], check=True, timeout=10)
        time.sleep(0.3)
        subprocess.run(["scrot", "-o", str(args.output / "native-print-selected.png")], check=True, timeout=10)
        native_key("alt+p")
        pdf = until(lambda: next((path for path in [Path("/output.pdf"), Path("/root/output.pdf"), Path("/work/output.pdf"), workspace / "output.pdf"] if path.is_file() and path.read_bytes().rstrip().endswith(b"%%EOF")), None))
        (args.output / "native-export.pdf").write_bytes(pdf.read_bytes())
        text = subprocess.check_output(["pdftotext", str(pdf), "-"], text=True)
        assert "Portable heading" in text and "Alpha" in text and "Start" in text and "Done" in text
        checks.append("native GTK print-to-PDF contains text, table and rendered diagram")
        native_key("ctrl+w")
        until(lambda: len(command("GET", "/window/handles")) == 1)
        command("POST", "/window", {"handle": document_window})
        until(lambda: button("Close"))
    original = command("GET", "/window")
    until(lambda: button("+ Window"))
    handles = until(lambda: (h if len(h:=command("GET", "/window/handles")) == 2 else None))
    other = next(h for h in handles if h != original)
    command("POST", "/window", {"handle": other})
    check("second native window shares canonical document", lambda: script("return document.title.includes('notes 東京.md')"))
    processes = []
    for process in Path("/proc").iterdir():
        try:
            if process.name.isdigit() and (process / "comm").read_text().strip() == "markdown-viewer":
                selected = [entry.decode() for entry in (process / "environ").read_bytes().split(b"\0") if entry.startswith((b"OWD=", b"APPIMAGE=", b"MARKDOWN_VIEWER_DATA_DIR="))]
                processes.append({"pid": process.name, "cwd": os.readlink(process / "cwd"), "environment": selected})
        except OSError: pass
    (args.output / "launch-environment.json").write_text(json.dumps(processes, indent=2))
    # The sender working directory must be honored by the single-instance handoff.
    subprocess.run([str(args.binary.resolve()), second.name], cwd=workspace, env=env, check=True, timeout=15)
    (args.output / "handoff-immediate.json").write_text(json.dumps({"body": script("return document.body.innerText")}, indent=2))
    check("second process hands relative path to focused window", lambda: script("return document.title.includes('second note.md')"))
    command("POST", "/window", {"handle": original})
    script("window.focus()")
    check("file opening leaves other window tabs alone", lambda: script("return !document.querySelector('.tabbar').innerText.includes('second note')"))
    until(lambda: button("Visual"))
    until(lambda: button("Edit table source"))
    check("explicit table draft opens", lambda: script("return !!document.querySelector('[aria-label=\"Inline source draft\"] .cm-content')"))
    until(lambda: script('const e=document.querySelector(\'[aria-label="Inline source draft"] .cm-content\'); if(e&&!e.closest(\'[inert]\')){e.scrollIntoView({block: \'center\'});return true}return false'))
    editor = command("POST", "/element", {"using": "css selector", "value": '[aria-label="Inline source draft"] .cm-content'})
    element_id = editor["element-6066-11e4-a52e-4f735466cecf"]
    command("POST", "/element/" + element_id + "/click", {})
    command("POST", "/element/" + element_id + "/value", {"text": " "})
    subprocess.run([str(args.binary.resolve()), str(second)], env=env, check=True, timeout=15)
    check("incoming file request uses draft navigation coordinator", lambda: script("return document.body.innerText.includes('Resolve unapplied draft')"))
    until(lambda: script("const d=[...document.querySelectorAll('[role=dialog]')].find(d=>d.innerText.includes('Resolve unapplied draft'));const b=d&&[...d.querySelectorAll('button')].find(b=>b.textContent==='Cancel');if(b){b.click();return true}return false"))
    check("Cancel retains draft and offers explicit request retry", lambda: script("return !!document.querySelector('[aria-label=\"Inline source draft\"] .cm-content')&&document.body.innerText.includes('Retry opening')"))
    until(lambda: button("Dismiss request"))
    check("dismissal preserves draft and document", lambda: script("return !!document.querySelector('[aria-label=\"Inline source draft\"] .cm-content')&&!document.body.innerText.includes('Retry opening')"))
    until(lambda: button("Cancel"))
    if args.binary.resolve().parent == Path("/usr/bin"):
        desktop = Path("/usr/share/applications/Marquellium.desktop")
        assert " %F" in desktop.read_text()
        third = workspace / "Open With 東京.md"
        third.write_text("# Desktop association\n", encoding="utf-8")
        subprocess.run(["gio", "launch", str(desktop), str(third)], env=env, check=True, timeout=15)
        check("installed desktop Open With forwards spaces and Unicode", lambda: script("return document.title.includes('Open With 東京.md')"))
    screenshot = command("GET", "/screenshot")
    (args.output / "native.png").write_bytes(base64.b64decode(screenshot))
    assert hashlib.sha256(fixture.read_bytes()).hexdigest() == source_hash
    checks.append("native opening and cancellation preserve file bytes")
    # WebDriver key injection bypasses GTK menu accelerators. Exercise the
    # same Rust quit_app entry point through IPC; native menu activation is a separate gate.
    until(lambda: script("const t=[...document.querySelectorAll('.tab')].find(t=>t.innerText.includes('notes 東京.md'));if(t){(t.querySelector('[role=tab]')||t).click();return true}return false"))
    until(lambda: button("Visual"))
    until(lambda: button("Edit table source"))
    until(lambda: script('const e=document.querySelector(\'[aria-label="Inline source draft"] .cm-content\'); if(e&&!e.closest(\'[inert]\')){e.scrollIntoView({block: \'center\'});return true}return false'))
    editor = command("POST", "/element", {"using": "css selector", "value": '[aria-label="Inline source draft"] .cm-content'})
    element_id = editor["element-6066-11e4-a52e-4f735466cecf"]
    command("POST", "/element/" + element_id + "/click", {})
    command("POST", "/element/" + element_id + "/value", {"text": " "})
    def quit_key():
        if args.native_keys:
            # Never send desktop input until the active window belongs to this
            # exact disposable application data directory. This runner is for Xvfb.
            active = subprocess.check_output(["xdotool", "getactivewindow"], text=True).strip()
            pid = subprocess.check_output(["xdotool", "getwindowpid", active], text=True).strip()
            environment = (Path("/proc") / pid / "environ").read_bytes().split(b"\0")
            if ("MARKDOWN_VIEWER_DATA_DIR=" + str(workspace / "data")).encode() not in environment:
                raise AssertionError("Refusing native input to a window outside this acceptance process")
            subprocess.run(["xdotool", "key", "--clearmodifiers", "ctrl+q"], env=env, check=True, timeout=10)
        else:
            script("window.__TAURI_INTERNALS__.invoke('quit_app').catch(e=>{window.m6QuitError=String(e)}); return true")
    quit_key()
    check(("native GTK Ctrl+Q" if args.native_keys else "native Quit command") + " coordinates both windows before closing", lambda: script("return document.body.innerText.includes('Resolve unapplied draft')") and len(command("GET", "/window/handles")) == 2)
    until(lambda: script("const d=document.querySelector('[role=dialog]');const b=d&&[...d.querySelectorAll('button')].find(b=>b.textContent==='Cancel');if(b){b.click();return true}return false"))
    check("Quit Cancel keeps both native windows and the draft", lambda: len(command("GET", "/window/handles")) == 2 and script("return !!document.querySelector('[aria-label=\"Inline source draft\"] .cm-content')&&!document.querySelector('[role=dialog]')"))
    def own_app_pids():
        result = []
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit(): continue
            try:
                if ("MARKDOWN_VIEWER_DATA_DIR=" + str(workspace / "data")).encode() in (entry / "environ").read_bytes().split(b"\0") and Path(os.readlink(entry / "exe")).name == "markdown-viewer": result.append(entry.name)
            except (OSError, PermissionError): pass
        return result
    assert own_app_pids(), "native application PID must be observed before Quit"
    quit_key()
    check("second Quit still prompts for the retained draft", lambda: script("return document.body.innerText.includes('Resolve unapplied draft')"))
    until(lambda: script("const d=document.querySelector('[role=dialog]');const b=d&&[...d.querySelectorAll('button')].find(b=>b.textContent==='Discard');if(b){b.click();return true}return false"))
    check("discarding the disposable draft quits the native process", lambda: not own_app_pids())
    assert hashlib.sha256(fixture.read_bytes()).hexdigest() == source_hash
    completed = True

except Exception:
    if session:
        try:
            snapshots = []
            for handle in command("GET", "/window/handles"):
                command("POST", "/window", {"handle": handle})
                snapshots.append({"handle": handle, "title": script("return document.title"), "body": script("return document.body.innerText")})
            (args.output / "windows.json").write_text(json.dumps(snapshots, indent=2))
            (args.output / "failure.json").write_text(json.dumps({"title": script("return document.title"), "body": script("return document.body.innerText"), "windows": command("GET", "/window/handles")}, indent=2))
        except Exception: pass
    raise
finally:
    (args.output / "results.json").write_text(json.dumps({"status": "passed" if completed else "failed", "checks": checks, "workspace": str(workspace), "binary": str(args.binary.resolve()), "offline": args.offline, "nativeKeys": args.native_keys, "networkTrace": args.trace_network, "exports": args.exports, "sourceSha256": source_hash, "finalSourceSha256": hashlib.sha256(fixture.read_bytes()).hexdigest()}, indent=2))
    if session:
        try: command("DELETE", "")
        except Exception: pass
    if driver.poll() is None:
        os.killpg(driver.pid, signal.SIGTERM)
    try: driver.wait(timeout=10)
    except subprocess.TimeoutExpired:
        os.killpg(driver.pid, signal.SIGKILL); driver.wait()
    if wm:
        wm.terminate()
        wm.wait(timeout=10)
    log.close()
