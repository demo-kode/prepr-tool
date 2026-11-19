# PrePR

Local review workspace for one task across multiple Git repositories. Side-by-side diffs,
line comments, replies, resolve/reopen, viewed files and immutable review snapshots.
No hosted service or external runtime dependencies. Python 3.12 standard library and plain JavaScript.

## Start

```bash
cd /path/to/prepr-tool
mkdir -p .local/data
docker compose up -d --build
```

Open http://127.0.0.1:18744. Container runs as UID/GID 1001; on another machine,
set its `user` in Compose and give that user write access to `.local/data`.
Loopback binding only. No repository, Git credential or Docker socket mounts.

## Publish a task

Create a manifest outside source code, such as a task's evidence directory:

```json
{
  "id": "search-timeout",
  "title": "Windows aggregate configuration",
  "description": "Move Windows publication into live; share the revision writer.",
  "repos": [
    {
      "name": "live",
      "path": "/path/to/my-task/live",
      "branch": "refactor/windows-config",
      "base": "<exact base commit SHA>",
      "exclude": ["evidence/**"]
    },
    {
      "name": "tasks",
      "path": "/path/to/my-task/tasks",
      "branch": "refactor/windows-config",
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

## Agent feedback loop

```bash
python3 review.py feedback search-timeout --open
python3 review.py feedback search-timeout --json
python3 review.py reply THREAD_ID 'Adjusted the timeout and verified the retry path.'
python3 review.py resolve THREAD_ID
python3 review.py resolve THREAD_ID --reopen
python3 review.py publish /path/to/task-review.json
```

Read feedback when the user requests it; there is no background agent execution. Replies default
to author `Codex`. Fix code in its worktree, test, reply with the outcome, then publish a new
snapshot under the same review ID. Questions can be answered without changing code.

## Data and operation

Snapshots, code and discussions live in `.local/data/reviews.sqlite` with SQLite WAL files.
They survive container rebuilds and restarts. Keep `.local` untracked. Stop the container before
copying the whole data directory for backup; restarting resumes the same reviews.

```bash
docker compose stop
docker compose start
docker compose logs --tail=50
```

Binary, non-UTF-8 and files over 1 MiB show metadata instead of an inline diff. Symlinks show
link targets and are never followed. No editing source files through the browser. No ADO/GitHub
posting, automatic code fixes or reviewer approval integration. Local feedback is not a remote
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
