#!/usr/bin/env python3
"""Profile the native release app without saving input or using normal app data."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import subprocess
import tempfile
import threading
import time

parser = argparse.ArgumentParser()
parser.add_argument('--runs', type=int, default=30)
parser.add_argument('--app', default='src-tauri/target/release/bundle/macos/Marquellium.app/Contents/MacOS/markdown-viewer')
parser.add_argument('--output', required=True)
args = parser.parse_args()
if not 1 <= args.runs <= 100:
    parser.error('Use 1–100 runs')
root = Path(tempfile.mkdtemp(prefix='marquellium-m5-bench-', dir='/private/tmp'))
document = root / 'one-mib.md'
paragraph = ('A technical **Markdown** paragraph with café 東京, a [link](#benchmark), and `code`. '
             + 'Plain text for editor latency and rendered preview. ' * 80 + '\n\n')
text = ('# Benchmark\n\n' + paragraph * 260)[:1048576] + '\n\nEnd of benchmark.\n'
document.write_text(text)
before = hashlib.sha256(document.read_bytes()).hexdigest()
rows = []
for index in range(args.runs):
    data = root / f'run-{index}'
    data.mkdir()
    (data / 'settings.json').write_text(json.dumps({'defaultMode': 'split', 'sidebar': {'visible': False, 'width': 240, 'section': 'toc'}}))
    (data / 'session.json').write_text(json.dumps({'schemaVersion': 1, 'tabs': [{'path': str(document), 'mode': 'split'}], 'activeIndex': 0, 'recentFiles': []}))
    started = time.monotonic()
    process = subprocess.Popen([str(Path(args.app).resolve()), '--m5-benchmark'],
                               env={**os.environ, 'MARKDOWN_VIEWER_DATA_DIR': str(data)},
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    observed = {'values': [], 'launchMs': None}
    def read_stdout():
        for line in process.stdout:
            if line.startswith('m5-benchmark-ready:'):
                observed['launchMs'] = (time.monotonic() - started) * 1000
            if line.startswith('m5-benchmark:'):
                observed['values'].append(json.loads(line.removeprefix('m5-benchmark:')))
    reader = threading.Thread(target=read_stdout, daemon=True)
    reader.start()
    try:
        process.wait(timeout=120)
    except subprocess.TimeoutExpired:
        process.kill()  # Only this disposable benchmark child.
        process.wait()
        raise RuntimeError(f'Benchmark run {index} timed out')
    reader.join(timeout=5)
    if process.returncode or not observed['values']:
        raise RuntimeError(f'Run {index}: {process.returncode}: {process.stderr.read()[-2000:]}')
    row = observed['values'][-1]
    row.update(wallSeconds=time.monotonic() - started, launchToUsableMs=observed['launchMs'])
    if 'error' in row or row['launchToUsableMs'] is None:
        raise RuntimeError(row)
    rows.append(row)
    print(f'Run {index + 1}/{args.runs}: open {row["openMs"]:.1f} ms, launch {row["launchToUsableMs"]:.1f} ms', flush=True)
assert hashlib.sha256(document.read_bytes()).hexdigest() == before

def p95(values):
    return sorted(values)[math.ceil(len(values) * .95) - 1]

result = {
    'binarySha256': hashlib.sha256(Path(args.app).read_bytes()).hexdigest(),
    'platform': platform.platform(), 'hardware': platform.machine(), 'runs': args.runs,
    'cache': 'Fresh process each run; OS caches warm after first run; no cache purge',
    'launchBoundary': 'Popen through native ready message after restored Split content and two animation frames',
    'openBoundary': 'Native run() entry through the same ready message; includes launch/restore, excludes dynamic loader',
    'fixtureBytes': document.stat().st_size, 'sourceUnchanged': True,
    'launchToUsableP95Ms': p95([r['launchToUsableMs'] for r in rows]),
    'openP95Ms': p95([r['openMs'] for r in rows]),
    'inputP95Ms': p95([v for r in rows for v in r['inputMs']]),
    'rows': rows, 'artifactDirectory': str(root),
}
Path(args.output).write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({k: v for k, v in result.items() if k != 'rows'}, indent=2))
