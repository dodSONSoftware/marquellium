# Marquellium user guide

Marquellium edits local Markdown files without an account. Read, Source, Split and Visual share one canonical document. Opening the same file in several windows shares applied edits, Save and document Undo/Redo. Tabs and selected modes belong to each window.

## Editing safely

Use Source for arbitrary Markdown. Visual directly edits supported text and table cells. Use **Edit block/table/math/Mermaid source** for structural changes. In a source draft, **Revert** restores its opening text and can itself be undone; **Cancel** abandons the draft; **Apply** commits one document-history transaction. Invalid or stale drafts retain their text and block Apply. A document has one draft owner at a time.

Mode changes, tab changes, Close and Quit resolve drafts before unsaved applied content. **Discard** in the draft prompt concerns only that draft. A later **Save / Discard / Cancel** prompt concerns the applied document. Cancel keeps windows open. Saving an earlier document during a multi-document Quit is not undone by canceling a later prompt.

Recovery opens previous unsaved content as a separate Untitled copy. Apply any recovered draft, inspect the result, then **Save As** to a new file. The original file is not overwritten automatically. Use **Open Recent** to reopen saved documents.

## Navigation and commands

Use **Files → Open folder…** to grant a folder to the current window. The tree and workspace search omit hidden files and symlinks. Exclusions accept comma-separated `*`, `**` and `?` patterns. Workspace search is literal, case-sensitive and reads saved Markdown/text files; unsaved buffers are not searched. Results show file and line; clicking opens the file. Search limits and skipped files are reported explicitly.

Use TOC for headings. Split scroll sync follows source blocks and can be disabled. **Commands… / Cmd+Shift+P** finds commands with the keyboard. **Cmd+F** opens Source Find/Replace; a pending draft must be resolved first. Standard New/Open/Save/Undo/Redo shortcuts route to the active document window.

## Preferences and images

**Preferences… / Cmd+,** configures System/Light/Dark appearance, default opening mode, document font/size/line spacing/width, independent editor font/size, frontmatter visibility and native spell check. Save applies changes across open document windows. Reset fills default values; save to persist them. Typography never changes Markdown. Font availability and system spelling dictionaries depend on macOS. Source syntax can be marked as misspelled; disable spelling if unwanted.

**Document tools → Paste image** imports the clipboard image as a uniquely named PNG beside a saved document, in the selected assets folder. Existing assets are not overwritten. The relative Markdown reference is an ordinary undoable edit; Undo does not delete the imported asset. Failed insertion reports the retained asset path. Link validation checks local targets/anchors without fetching remote URLs.

Statistics are debounced off the typing thread. Word count is approximate, Unicode character count includes code points, and reading time assumes 200 words/minute.

## Export

Choose **Export… / Cmd+Shift+E** and resolve pending drafts. Exports use a snapshot of applied content and leave the Markdown unchanged. Canceling the save dialog writes no export.

- **HTML:** one static document with inline CSS, embedded raster images and static Mermaid diagrams. Math uses native MathML, so appearance depends on the recipient's browser. No scripts or remote images/fonts load. Relative hyperlinks resolve relative to the exported HTML's folder; move sibling files alongside it or use external links. Local images outside the document folder need an explicitly chosen workspace containing both paths. Missing/blocked resources retain visible source/alt text.
- **PDF:** opens a dedicated print preview. Click **Print / Save PDF…**, select paper/scaling and use macOS's PDF menu. The PDF is written only after the native dialog confirms it. Tables/large figures can cross page boundaries; inspect pagination. There is no fixed page-number template.
- **DOCX:** headings, paragraphs, emphasis, links, tables and blockquotes are represented as OOXML. List numbering/task markers are visible text, preserving meaning without interactive checkboxes. PNG images embed; other image formats retain visible source/alt text. Math and Mermaid remain labeled source blocks. Raw HTML/unknown constructs remain escaped source. Table alignment/layout and fonts can differ from the app; local links/bookmarks may need adjustment in Word. Inspect the output before publishing.

Exports are bounded to 2 MiB of source, 8 MiB per image, 24 MiB HTML and 32 MiB DOCX. Too-large or unavailable content is reported or retains a visible fallback. Windows/Linux print behavior is not yet accepted.
