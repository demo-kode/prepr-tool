<div align="center">
  <img src="docs/assets/banner.svg" alt="PrePR — Catch the little things. Before the pull request." width="100%">
  <p><strong>Your code. Your machine. One more look.</strong></p>
  <p>A local review desk for humans and coding agents.<br>Real Git diffs, line comments, and one conversation across multiple repositories.</p>
  <p><a href="#quick-start">Get started</a> · <a href="#publish-a-task">Publish a review</a> · <a href="skills/prepr-review/SKILL.md">Agent skill</a> · <a href="#data-and-operation">How data stays local</a></p>
</div>

![PrePR dark interface showing a synthetic search change and a line comment](docs/assets/review.png)

<p align="center"><sub>Demo code and fictional feedback. No real project data.</sub></p>

## A little review before the big review

Catch a surprising deletion. Ask why a timeout changed. Let your agent answer on the exact line.
PrePR gives unfinished work a comfortable place to be reviewed before it becomes a hosted PR.

| Bring your changes | Keep the conversation |
| --- | --- |
| **Real Git diffs** — pinned base → current worktree | **Line comments** — before, after, or the whole file |
| **Multiple repositories** — one task, one review | **Agent loop** — read, reply, adjust, republish |
| **Moves and copies** — compare against original code | **Stable snapshots** — old feedback keeps its original context |
| **Dark by default** — side-by-side diffs, focused navigation | **Local storage** — code and comments stay on your machine |

Python standard library + plain JavaScript, with a bundled syntax highlighter.
No database service, frontend build step, or runtime package install needed to run the app.

## Quick start

You need **Docker with Compose**, **Git**, and **Python 3.12+** on the host.
Run these commands in a POSIX shell:

```bash
git clone https://github.com/demo-kode/prepr-tool.git
cd prepr-tool
mkdir -p .local/data

# Match the container user to the local data directory.
cat > compose.override.yaml <<EOF
services:
  review:
    user: "$(id -u):$(id -g)"
EOF

docker compose up -d --build
```

Open **[127.0.0.1:18744](http://127.0.0.1:18744)**. Publish a task below to see your first diff.
The container binds to loopback and runs without repository, credential, or Docker socket mounts.
The host CLI reads Git and sends the selected snapshot to the local app.

## Publish a task

Create a manifest outside source code, such as a task's evidence directory:

```json
{
  "id": "search-timeout",
  "title": "Give slow searches time to finish",
  "description": "Adjust the API timeout and worker settings.",
  "repos": [
    {
      "name": "api",
      "path": "/absolute/path/to/api",
      "branch": "fix/search-timeout",
      "base": "<exact base commit SHA>",
      "exclude": ["evidence/**"]
    },
    {
      "name": "worker",
      "path": "/absolute/path/to/worker",
      "branch": "fix/search-timeout",
      "base": "<exact base commit SHA>"
    }
  ]
}
```

```bash
python3 review.py publish /path/to/task-review.json
```

- Pin `base` to the task's starting commit. For a complete proposed PR, use the merge-base
  of its target and branch. For an incremental follow-up, use the last reviewed commit.
- Capture compares the chosen base with the current worktree: branch commits, staged,
  unstaged and non-ignored untracked files. `branch` checks the checkout; it does not switch it.
- Optional `include` and `exclude` are case-sensitive path globs. Inspect scope before publishing;
  unrelated edits in the same worktree are otherwise included.
- `HEAD` is supported for an uncommitted-only review, but an exact SHA keeps the baseline stable
  across subsequent commits. No Git fetch, checkout, commit or push occurs.
- Finish edits before capture. Do not edit a worktree while publishing its snapshot.
- Repeating an identical publication reuses its snapshot. Changed content creates a new one.

Open the printed URL. Added and deleted files use the full diff width. Click any before/after line number to comment. Deleted lines support
comments too. Change “Comment as” to your name. Use **Discussion** for all open threads,
including earlier snapshots. **Refresh** fetches new replies; the snapshot selector opens revisions.

Comments stay on their original snapshot and code. They are never silently moved to a different
line after edits. Viewed flags also belong to a snapshot. Older comments remain actionable from
Discussion; select their anchor to open the original diff.

## Choose your view

The file toolbar shows **repository / path** and three views:

- **Split** compares before and after side by side. Drag the center divider to resize the columns.
- **Unified** shows one diff with old/new line numbers, removals, and additions.
- **Raw** shows the full file. Choose **Before** or **After**; long files load 2,000 lines at a time.

Drag the divider beside the file list to change its width. Both dividers support arrow keys when
focused and double-click to reset. View choice and divider positions persist in your browser.
Line comments and syntax highlighting work across views; comments retain their original side and line.

## Git comparisons

The CLI reads each pinned base directly from Git and compares it with the worktree using
`git diff --no-index --histogram`. Source paths, branch names and base commits remain visible.
Moves between repositories compare against their original Git contents. Exact or unambiguous
same-name matches are detected automatically; source deletions link to the destination comparison.
New files without a source remain additions.

For a copy, partial move or ambiguous source, add an explicit mapping at manifest root:

```json
"comparisons": [
  {
    "repo": "api",
    "path": "src/settings.py",
    "fromRepo": "worker",
    "fromPath": "shared/settings.py"
  }
]
```

`fromRepo` must be in the same review. The source comes from that repository's pinned base,
not its modified worktree. Retained sources keep their own normal Git diff. Comparisons show
provenance; they do not alter Git's index or history.

Use **Comment on file** for general feedback, or the visible **+** beside a line for inline
feedback. **Post comment** saves immediately; comments and replies are readable by the agent CLI.
Use the trash icon on a comment or reply to delete it. Empty threads disappear. Deleted messages
are excluded from the UI and agent feedback; their records remain in the private local database.
Closed reviews remain read-only.

## Syntax highlighting

Diffs use [Shiki](https://shiki.style/), with **242 bundled language grammars** and a dark theme.
Terraform/HCL, shell, PowerShell, Python, TypeScript/JSX, Svelte, Vue, YAML, JSON, Markdown,
SQL, Java, Kotlin, Go, C/C++, Dockerfiles, and more work locally. Added small grammars cover
Salt's YAML + Jinja, ignore patterns, and LDIF.

Filename, extension, and script shebang automatically select the language. Before and after can use different
grammars when a file changes extension. Unknown formats stay readable as plain text; binary
files still show metadata.

Tokenization runs in a worker, using whole-file context so multiline strings and comments
remain correct across diff hunks. Source text and comment line numbers stay unchanged.
All scripts, grammars, the theme, and WebAssembly are served by the local app; no CDN requests.
Files above 300,000 characters, lines above 20,000 characters, or jobs exceeding eight seconds
fall back to plain text to keep review responsive.

The prebuilt bundle is included. Maintainers can rebuild it with Node.js 22+:

```bash
npm ci --prefix tooling/highlighting --ignore-scripts
node tooling/highlighting/build.mjs
```

Versions and integrity hashes are pinned in the lockfile. Dependency notices are in
[static/vendor/LICENSES.txt](static/vendor/LICENSES.txt).

## Agent skill

The bundled [agent skill](skills/prepr-review/SKILL.md) lives in this repository. Install it by symlinking that directory
into your agent's skill directory, for example:

```bash
mkdir -p ~/.codex/skills
ln -s "$(pwd)/skills/prepr-review" ~/.codex/skills/prepr-review
```

It covers choosing stable Git bases, scoping multi-repo snapshots, move comparisons, preserving
comments and answering feedback. New sessions can discover it as `$prepr-review`.

## Review with your working agent

When a change set is ready, the skill offers to open PrePR. Accept, and the same working agent
opens the review page and watches for your comments. It keeps its existing conversation context,
model and effort settings. Each comment gets replies in its own discussion thread.

**No agent configuration or separate launcher.** The local helper polls stored feedback through
the API and hands it back to the active agent. That agent answers questions, applies scoped fixes,
tests, and republishes the same change set. It never starts another CLI or copies chat transcripts
into Docker. You can also use the page without live monitoring.

The header shows **working session watching** during live review. Use the two actions at the top right:

- **Keep** closes the local review, preserves your local changes, and stops comment watching.
- **Ship it** closes comment review and asks the working agent to create PRs for the affected
  repositories. The request is pinned to the displayed snapshot; the agent verifies that scope
  before committing or pushing. PR links or a blocking reason appear in the review.

Both decisions persist across restarts. Closed reviews keep their diffs and discussions, but
accept no further comments or snapshots; use a new review for later changes. Ship it requests
remain pending if the working agent is offline. Returning to the original session delivers the
request; the app never launches a replacement agent. Ship it requests PR creation, not merging
or deployment, and preserves explicit publication/visibility restrictions.

You can also tell the agent to stop without closing the review. Monitoring needs an active agent session; closing or ending
that session stops the feedback loop. The watching indicator expires after two minutes without a
heartbeat. Ask the original working agent to resume when you return.

Replies appear automatically without discarding a comment draft. When the agent publishes code
changes, **Open updated diff** lets you switch snapshots while preserving the original anchors.

The skill handles these commands from the working conversation:

```bash
python3 review.py watch-start REVIEW_ID --state .local/review-watch.json --author Codex
python3 review.py watch --state .local/review-watch.json --timeout 45
# Read comments, reply, fix and test, then acknowledge the returned batch.
python3 review.py watch-ack --state .local/review-watch.json
python3 review.py watch-heartbeat --state .local/review-watch.json
python3 review.py watch-stop --state .local/review-watch.json
```

Use one state file per change set. For Claude Code, use `--author 'Claude Code'` and the same author
when replying. `watch-start --session ID` records an optional session reference; Codex's environment
session ID is detected automatically. This is ownership metadata, not a command to resume a model.
Watch calls return within 50 seconds, include earlier snapshot anchors, exclude the agent's own
replies, and retain unacknowledged comments for retry. Comments arriving during edits remain for
the next poll. Renew ownership at least once a minute during longer work.

## Agent feedback loop

**Change → publish → comment → adjust → repeat.** No remote PR required.

```bash
python3 review.py feedback search-timeout --open
python3 review.py feedback search-timeout --json
python3 review.py reply THREAD_ID 'Adjusted the timeout and verified the retry path.'
python3 review.py resolve THREAD_ID
python3 review.py resolve THREAD_ID --reopen
python3 review.py publish /path/to/task-review.json
```

For a manual session, read feedback when the user requests it. Replies default
to author `Codex`; use `--author` for another agent. Fix code in its worktree, test, reply with the outcome, then publish a new
snapshot under the same review ID. Questions can be answered without changing code.

## Data and operation

**Local does not mean secret-free.** Snapshots contain the code you choose to review.
Inspect scope before publishing, keep the service on loopback, and keep its data private.
There is no authentication for shared or network-facing deployment.

Snapshots, code and discussions live in `.local/data/reviews.sqlite` with SQLite WAL files.
They survive container rebuilds and restarts. Keep `.local` untracked. Stop the container before
copying the whole data directory for backup; restarting resumes the same reviews.

```bash
docker compose stop
docker compose start
docker compose logs --tail=50
```

Binary, non-UTF-8 and files over 1 MiB show metadata instead of an inline diff. Symlinks show
link targets and are never followed. No editing source files through the browser. No hosted PR
posting or reviewer approval integration. Code changes are handled by the working agent during an accepted review. Local feedback is not a remote
PR approval. Review payloads are capped at 32 MiB and 3,000 files.

## Validation

```bash
python3 -m unittest discover -s tests -v
node --check static/app.js
```

Tests cover Git scope, commits/index/worktree capture, renames, deletions, symlinks, binary/large
files, line anchors, immutable history, persistent feedback, replies/status, viewed state and
local-origin checks. The local browser smoke test also exercised comments/replies, version
navigation, search and escaped code/comment rendering.

Optional browser smoke test: install Playwright in a separate test environment, start a disposable
server on port 18745, then run `node tests/browser.cjs`. `PLAYWRIGHT_MODULE` accepts an existing
Playwright module path; `PREPR_TEST_URL` overrides the test server URL. Fixtures stay on that server.
Do not run the smoke test against the working review service.

The additional `node tests/highlighting.cjs` browser test uses the same disposable server and
Playwright settings. It checks language coverage, multiline tokens, exact source preservation,
comment anchors, safe rendering, automatic language detection, and local-only requests.

`node tests/views.cjs` checks split/unified/raw rendering, before/after comment anchors,
raw pagination, draft protection, pointer/keyboard resizing, saved widths, and mobile layout.

`node tests/live-review.cjs` checks live ownership, Keep/Ship it, durable closure and removal of launcher controls.
Python tests cover comment polling, acknowledgement, reply filtering, ownership expiry, restart, snapshot-pinned shipping, and duplicate-request recovery.
