# Git Commit Workflow Instructions

## Purpose

Analyze the repository and Git history to determine what has changed, update the version, create or update `README.md`, generate `GIT_COMMIT_MESSAGE`, stage the intended repository changes, and **execute the Git commit** using that message.

These instructions are language-agnostic and apply to any Git repository.

**This is an execution workflow, not a dry run.** Perform `git add` and `git commit`. Do not push, tag, deploy, amend an existing commit, or rewrite Git history.

## 1. Analyze the Repository

Inspect the repository to understand the project and its changes.

1. Review the project structure, configuration, documentation, and relevant source files.
2. Examine `git status`, including staged, unstaged, and untracked files.
3. Review `git diff` and `git diff --cached`.
4. Examine recent Git history, including commit messages and their associated changes.
5. Compare the current working tree against `HEAD`.
6. Inspect relevant untracked files.
7. Determine the purpose, scope, and impact of the changes.
8. Identify new features, bug fixes, breaking changes, refactoring, documentation, and maintenance work.

Use additional Git commands and repository inspection as necessary.

Base conclusions on actual changes, not merely filenames or commit messages.

Do not modify existing source code or unrelated files.

Ignore any existing `GIT_COMMIT_MESSAGE`, the prior release line in `README.md`, and previous automatic `VERSION` edits when classifying functional changes. These files are maintained by this workflow; they must not be mistaken for new functionality.

Inspect the scope of changes before staging. Include intentional additions, modifications, renames, and deletions. Do not silently stage secrets, credentials, local environment files, or unrelated generated artifacts. If the intended commit scope is ambiguous or includes sensitive files, stop and report the issue rather than committing unsafe content.

Git history is evidence for analyzing changes, **not** the authority for deciding whether the existing `VERSION` may be incremented.

## 2. Version Management

The repository root contains a plain-text file named `VERSION` with one `MAJOR.MINOR.PATCH` value and a trailing newline.

### Initialization

At the start of each execution, check whether `VERSION` exists.

- **Missing file:** Create `VERSION` containing `0.0.0` and a newline. Use `0.0.0` for this execution. Do not increment it again during the initialization execution.
- **Existing file:** Read and validate its contents. Use that exact value as the baseline, regardless of whether the file is tracked, untracked, staged, modified, or differs from Git history.
- If the existing value is malformed, stop and report the issue. Do not replace it silently.

### Version Increment

If `VERSION` existed at the beginning of this execution, **increment it exactly once** according to the classification of the current changes.

1. Read the current value from `VERSION`.
2. Determine the highest applicable increment: MAJOR, MINOR, or PATCH.
3. Apply that increment to the current value.
4. Write the resulting value to `VERSION`, followed by a newline.

**Do not compare `VERSION` against Git `HEAD` to decide whether an increment is allowed. Do not preserve an existing version on the grounds that it is untracked or was already changed. Every execution with an existing valid `VERSION` increments it exactly once.**

If no project changes other than release metadata are detected, use PATCH and create a version-only commit. Do not invent feature or fix claims in that commit.

### Semantic Versioning

| Change | Increment | Calculation |
|---|---|---|
| Breaking change | MAJOR | `M.m.p` → `(M+1).0.0` |
| New backward-compatible functionality | MINOR | `M.m.p` → `M.(m+1).0` |
| Bug fix, refactoring, documentation, or maintenance | PATCH | `M.m.p` → `M.m.(p+1)` |

When multiple change types exist, use the highest applicable increment.

Examples:

- MAJOR: `0.9.5` → `1.0.0`; `1.6.3` → `2.0.0`
- MINOR: `0.0.0` → `0.1.0`; `1.6.3` → `1.7.0`
- PATCH: `0.0.0` → `0.0.1`; `1.6.3` → `1.6.4`

**Major version zero is ordinary.** Never apply special restrictions or different increment rules to `0.Y.Z`. Determine increments from the nature of the changes, not from the existing numeric value.

The root `VERSION` file is the sole authoritative source for the current version. Do not change language-specific version declarations unless separately instructed. Do not use the README release line or committed version as an alternative baseline.

## 3. Release Codename

Every version receives a deterministic release codename based on its MAJOR and MINOR components.

- **MAJOR** determines the Predator.
- **MINOR** determines the Material.
- **PATCH** does not affect the codename.
- The format is always `<Material> <Predator>`.

### Major Version → Predator

| Major | Predator |
|---:|---|
| 0 | Ferret |
| 1 | Mongoose |
| 2 | Owl |
| 3 | Fox |
| 4 | Bobcat |
| 5 | Coyote |
| 6 | Lynx |
| 7 | Badger |
| 8 | Hawk |
| 9 | Falcon |
| 10 | Eagle |
| 11 | Wolverine |
| 12 | Wolf |
| 13 | Cougar |
| 14 | Leopard |
| 15 | Jaguar |
| 16 | Lion |
| 17 | Tiger |
| 18 | Grizzly |
| 19 | Megalodon |
| 20 | Giganotosaurus |
| 21 | Direwolf |
| 22 | Raptor |
| 23 | Spinosaurus |
| 24 | Tyrannosaurus |
| 25 | Wyvern |
| 26 | Griffin |
| 27 | Manticore |
| 28 | Basilisk |
| 29 | Chimera |
| 30 | Cerberus |
| 31 | Hydra |
| 32 | Dragon |
| 33 | Kraken |
| 34 | Typhon |
| 35 | Leviathan |

### Minor Version → Material

| Minor | Material |
|---:|---|
| 0 | Iron |
| 1 | Zinc |
| 2 | Aluminum |
| 3 | Tin |
| 4 | Bronze |
| 5 | Brass |
| 6 | Copper |
| 7 | Nickel |
| 8 | Steel |
| 9 | Mercury |
| 10 | Titanium |
| 11 | Cobalt |
| 12 | Carbon |
| 13 | Graphite |
| 14 | Silicon |
| 15 | Ceramic |
| 16 | Quartz |
| 17 | Onyx |
| 18 | Obsidian |
| 19 | Garnet |
| 20 | Amethyst |
| 21 | Topaz |
| 22 | Granite |
| 23 | Opal |
| 24 | Jade |
| 25 | Turquoise |
| 26 | Pearl |
| 27 | Emerald |
| 28 | Sapphire |
| 29 | Ruby |
| 30 | Silver |
| 31 | Gold |
| 32 | Platinum |
| 33 | Amber |
| 34 | Marble |
| 35 | Diamond |

### Codename Rules

1. Parse the final version as `MAJOR.MINOR.PATCH`.
2. Look up MAJOR in the Predator table.
3. Look up MINOR in the Material table.
4. Ignore PATCH.
5. Combine the results in exactly this order: `Material Predator`.
6. Preserve the exact spelling and capitalization.
7. Do not invent or substitute names.
8. For an out-of-range component, use `Unknown`.

### Examples

| Version | Codename |
|---|---|
| `0.0.0` | Iron Ferret |
| `3.6.0` | Copper Fox |
| `12.16.2` | Quartz Wolf |
| `17.31.0` | Gold Tiger |
| `20.35.0` | Diamond Giganotosaurus |
| `24.35.0` | Diamond Tyrannosaurus |
| `32.30.0` | Silver Dragon |
| `34.31.0` | Gold Typhon |
| `35.35.0` | Diamond Leviathan |
| `36.3.0` | Tin Unknown |
| `3.36.0` | Unknown Fox |

Patch releases retain the same codename:

```text
3.6.0  → Copper Fox
3.6.1  → Copper Fox
3.6.99 → Copper Fox
```

## 4. Create or Update README.md

The repository root must contain a `README.md` file reflecting the current project and release information.

### If README.md Does Not Exist

1. Analyze the repository to determine the project name, purpose, and functionality.
2. Create `README.md` in the repository root.
3. Use the project's actual name when identifiable; otherwise, use the repository directory name.
4. Write a concise, accurate project description based on the repository contents.
5. Insert the release line immediately beneath the H1 project title.
6. Include additional project information only when supported by the repository contents.
7. Do not invent features or capabilities.

Use this structure:

```markdown
# Project Name

**Release:** Copper Fox — version 3.6.0.

A brief description of the project.
```

### If README.md Already Exists

1. Preserve the existing project title, description, and documentation.
2. Locate the primary H1 project title.
3. Insert or update the release line immediately beneath the title.
4. Replace any existing release line rather than adding a duplicate.
5. Preserve all unrelated README content and formatting.
6. Do not rewrite or restructure the README unnecessarily.

### Release Line Format

Use this exact template:

```text
**Release:** <Material> <Predator> — version <MAJOR.MINOR.PATCH>.
```

Requirements:

- One blank line between the H1 title and release line.
- One blank line after the release line.
- Material before Predator.
- Use an em dash (`—`).
- Use lowercase `version`.
- No `v` prefix.
- End with a period.
- Ensure exactly one current release line immediately beneath the title.

The version must match the final value in `VERSION`.

## 5. Generate GIT_COMMIT_MESSAGE

Create or overwrite the file `GIT_COMMIT_MESSAGE` in the repository root.

The message must describe the actual changes identified during repository analysis, including changes made to `VERSION` and `README.md`.

### Commit Message Format

```text
<type>: <overview>

[X.Y.Z] <Material> <Predator>

- <change 1>
- <change 2>
- <change 3>

developed by Randel Dodson and AI
```

The first line follows Conventional Commits syntax. The second paragraph identifies the release version and codename.

### Conventional Commit Types

| Type | Purpose |
|---|---|
| `feat` | New functionality |
| `fix` | Bug fixes |
| `chore` | Maintenance |
| `refactor` | Code restructuring |
| `docs` | Documentation |
| `test` | Tests |
| `perf` | Performance improvements |
| `ci` | CI configuration |
| `build` | Build system changes |
| `style` | Formatting changes |

### Commit Message Rules

1. The first line must follow Conventional Commits syntax: `<type>: <overview>`.
2. Select the type that best represents the primary changes.
3. Write a concise, meaningful overview.
4. The second paragraph must contain the final version and calculated codename, formatted exactly as `[X.Y.Z] <Material> <Predator>`.
5. Separate the header, release identification, change descriptions, and attribution with one blank line.
6. Include one-line bullet descriptions for significant files or groups of changes.
7. Include `VERSION` and `README.md` changes when applicable.
8. For breaking changes, add a `BREAKING CHANGE:` footer with migration notes before the attribution.
9. End with the exact line `developed by Randel Dodson and AI`.
10. Do not append `Co-Authored-By` or other attribution footers.
11. Do not list `GIT_COMMIT_MESSAGE` as a change within its own message.
12. Do not include speculative changes or claim work was performed when it was not.
13. Do not repeat the version or codename in the header unless relevant to the change description.
14. On a version-only commit, use `chore` and describe only the version and release metadata updates.
15. Generate the message **before** staging, and use the file itself as the commit message source.

### Example

```text
fix: improve network connection recovery

[3.6.1] Copper Fox

- network: Improve reconnection after temporary failures
- config: Correct connection retry handling
- tests: Add regression coverage for connection failures
- VERSION: Update version to 3.6.1
- README.md: Update Copper Fox release information

developed by Randel Dodson and AI
```

### Example — Initial Commit (VERSION was missing)

```text
docs: add universe, interface, and facility design records with continuation handoffs

[0.0.0] Iron Ferret

- design: Add universe-initialization and planetary-packets documentation
- design: Expand player-experience and management-interface specifications
- design: Add planetary-site and industrial-planning records
- design: Document interstellar navigation and expedition planning
- handoffs: Add development continuation records and resume prompts
- VERSION: Initialize version file to 0.0.0
- README.md: Add project overview and Iron Ferret release information

developed by Randel Dodson and AI
```

### Example — Documentation Changes After Initialization

```text
docs: expand universe and interface design records

[0.0.1] Iron Ferret

- design: Expand universe-initialization and management-interface documentation
- handoffs: Add development continuation records
- VERSION: Increment version from 0.0.0 to 0.0.1
- README.md: Update Iron Ferret release information

developed by Randel Dodson and AI
```

### Example — No Additional Project Changes

```text
chore: advance project release version

[0.0.2] Iron Ferret

- VERSION: Increment version from 0.0.1 to 0.0.2
- README.md: Update Iron Ferret release information

developed by Randel Dodson and AI
```

## 6. Validate Before Committing

Before staging:

1. Verify `VERSION` exists and contains the resolved version.
2. If it was created in this execution, verify it is `0.0.0`. Otherwise verify it was incremented exactly once from its initial value.
3. Verify the version increment matches the change classification, including a PATCH fallback for version-only commits.
4. Verify the release codename matches MAJOR and MINOR.
5. Verify `README.md` exists, contains an H1 project title, and has exactly one release line matching `VERSION`.
6. Verify unrelated README documentation was preserved.
7. Verify `GIT_COMMIT_MESSAGE` exists, has the correct Conventional Commit header, release line, factual change summary, and exact attribution as its final line.
8. Verify the intended staging set contains the real project changes and the three maintained files, without sensitive or unrelated files.
9. Stop and report errors instead of committing invalid or unsafe content.

## 7. Stage and Commit

**You must actually execute these operations.** The task is not complete after writing `GIT_COMMIT_MESSAGE`.

1. Stage the intended repository changes, including new, modified, and deleted files, plus `VERSION`, `README.md`, and `GIT_COMMIT_MESSAGE`. When the complete repository change set is appropriate, execute:

   ```bash
   git add -A
   ```

   If unrelated or sensitive files are present, do not use a blanket `git add -A`; resolve the unsafe staging scope first. Do not silently omit intentional project changes.

2. Inspect the staged diff and names before committing:

   ```bash
   git diff --cached --stat
   git diff --cached --name-status
   git diff --cached --check
   ```

   Confirm the staged changes match the analysis, including additions, deletions, `VERSION`, `README.md`, and `GIT_COMMIT_MESSAGE`.

3. Execute the commit using the exact message stored in the root file:

   ```bash
   git commit -F GIT_COMMIT_MESSAGE
   ```

   Do not substitute an abbreviated `-m` message. Preserve the complete message body and attribution.

4. Verify success with:

   ```bash
   git log -1 --format='%h %s'
   git status --short
   ```

5. If `git add`, a validation step, or `git commit` fails, report the error accurately. Do not claim the commit succeeded; do not bypass hooks, force the commit, or silently retry with a different message.

Do not run `git push`, create tags, deploy, amend commits, or rewrite history.

## 8. Report

After completion, report:

- Previous version (or `missing`) and final version.
- Applied increment: INITIALIZATION, MAJOR, MINOR, or PATCH.
- Release codename and Conventional Commit type.
- Summary of actual project changes.
- Files created or updated by this workflow.
- Whether `git add` and `git commit` succeeded.
- Commit short SHA and subject if successful.
- Any remaining uncommitted files or errors.

This workflow is permitted to **create or modify** only these maintained files:

```text
VERSION
README.md
GIT_COMMIT_MESSAGE
```

It must **stage and commit the existing project changes** identified in the repository as well as those three files. Leave pre-existing source changes intact; do not rewrite source code as part of commit preparation.

**A successful run ends with an actual Git commit. Do not push, tag, or deploy.**
