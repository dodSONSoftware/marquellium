#!/usr/bin/env python3
"""Native WebKitGTK smoke through Tauri's W3C driver; only disposable data.
Run under dbus-run-session + xvfb-run. Requires tauri-driver 2.1.0 and WebKitWebDriver.
No production test bridge or external Python packages.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError

parser = argparse.ArgumentParser()
parser.add_argument("binary", type=Path)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
workspace = Path(tempfile.mkdtemp(prefix="marquellium-m6-"))
fixture = workspace / "notes 東京.md"
fixture.write_text("# Portable heading\n\n![local](pixel.png)\n\nMath: $x^2$\n\n```mermaid\nflowchart LR\n A[Start] --> B[Done]\n```\n\n| Item | Amount |\n| --- | ---: |\n| Alpha | 10 |\n", encoding="utf-8")
(workspace / "pixel.png").write_bytes(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg=="))
second = workspace / "second note.md"
second.write_text("# Second file\n", encoding="utf-8")
env = dict(os.environ, MARKDOWN_VIEWER_DATA_DIR=str(workspace / "data"))
log = (args.output / "driver.log").open("w")
wm = subprocess.Popen(["openbox"], stdout=log, stderr=subprocess.STDOUT) if os.environ.get("DISPLAY") else None
driver = subprocess.Popen(["tauri-driver"], env=env, stdout=log, stderr=subprocess.STDOUT)
session = None
checks = []

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
    assert fixture.read_text(encoding="utf-8").find("| Alpha | 10 |") >= 0
    checks.append("native opening and cancellation preserve file bytes")
    # WebDriver key injection bypasses GTK menu accelerators. Exercise the
    # same Rust quit_app entry point through IPC; native menu activation is a separate gate.
    until(lambda: script("const t=[...document.querySelectorAll('.tab')].find(t=>t.innerText.includes('notes 東京.md'));if(t){t.click();return true}return false"))
    until(lambda: button("Visual"))
    until(lambda: button("Edit table source"))
    until(lambda: script('const e=document.querySelector(\'[aria-label="Inline source draft"] .cm-content\'); if(e&&!e.closest(\'[inert]\')){e.scrollIntoView({block: \'center\'});return true}return false'))
    editor = command("POST", "/element", {"using": "css selector", "value": '[aria-label="Inline source draft"] .cm-content'})
    element_id = editor["element-6066-11e4-a52e-4f735466cecf"]
    command("POST", "/element/" + element_id + "/click", {})
    command("POST", "/element/" + element_id + "/value", {"text": " "})
    def quit_key():
        script("window.__TAURI_INTERNALS__.invoke('quit_app').catch(e=>{window.m6QuitError=String(e)}); return true")
    quit_key()
    check("native Quit command coordinates both windows before closing", lambda: script("return document.body.innerText.includes('Resolve unapplied draft')") and len(command("GET", "/window/handles")) == 2)
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
    (args.output / "results.json").write_text(json.dumps({"checks": checks, "workspace": str(workspace), "binary": str(args.binary.resolve())}, indent=2))
    if session:
        try: command("DELETE", "")
        except Exception: pass
    driver.terminate()
    try: driver.wait(timeout=10)
    except subprocess.TimeoutExpired: driver.kill(); driver.wait()
    if wm:
        wm.terminate()
        wm.wait(timeout=10)
    log.close()
