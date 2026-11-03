#!/usr/bin/env python3
"""Independent checks for exports produced by the native acceptance workflow."""
import argparse
import base64
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import xml.etree.ElementTree as ET
from zipfile import ZipFile

parser = argparse.ArgumentParser()
parser.add_argument('directory', type=Path)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
root = args.directory
expected = ['Level six', 'Ada', 'Grace', 'answer', 'unchecked task', 'nested', 'End of export fixture']

class Inspect(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tags, self.images, self.text = [], [], []
    def handle_starttag(self, tag, attrs):
        self.tags.append(tag)
        if tag == 'img':
            self.images.append(dict(attrs)['src'])
    def handle_data(self, data):
        self.text.append(data)

html = Inspect()
html.feed((root / 'export-fixture-accepted.html').read_text())
assert not any(tag in html.tags for tag in ['script', 'iframe', 'object'])
assert html.tags.count('math') == 2
assert len(html.images) == 2 and all(uri.startswith('data:image/') for uri in html.images)
for uri in html.images:
    assert base64.b64decode(uri.split(',', 1)[1], validate=True)
for phrase in expected:
    assert phrase in ''.join(html.text), phrase

with ZipFile(root / 'export-fixture-accepted.docx') as archive:
    assert archive.testzip() is None
    for name in archive.namelist():
        if name.endswith(('.xml', '.rels')):
            ET.fromstring(archive.read(name))
    text = ''.join(ET.fromstring(archive.read('word/document.xml')).itertext())
    for phrase in expected + ['TeX source', 'Mermaid diagram']:
        assert phrase in text, phrase
    assert archive.read('word/media/image1.png') == (root / 'assets/diagram.png').read_bytes()

# Rendering/visual QA is separate; this checks actual saved PDF text and controls.
import pdfplumber
with pdfplumber.open(root / 'export-fixture-accepted.pdf') as pdf:
    text = '\n'.join(page.extract_text() or '' for page in pdf.pages)
    for phrase in expected:
        assert phrase in text, phrase
    assert 'Print / Save PDF' not in text
    page_count = len(pdf.pages)

before = json.loads((root / 'before-sha256.json').read_text())
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
assert all(sha(root / path) == value for path, value in before.items())
result = {'htmlStaticAndEmbedded': True, 'docxZipCrcXmlContentAndPng': True,
          'pdfExpectedTextAndNoControls': True, 'pdfPages': page_count,
          'sourceAndOriginalImageUnchanged': True,
          'sha256': {name: sha(root / name) for name in ['export-fixture.md', 'assets/diagram.png',
                     'export-fixture-accepted.html', 'export-fixture-accepted.docx', 'export-fixture-accepted.pdf']}}
args.output.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
