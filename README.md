<div align="center">
  <img src="docs/assets/banner.svg" alt="PrePR — Catch the little things. Before the pull request." width="100%">
  <p><strong>Review agent work locally, before the PR.</strong></p>
</div>

![PrePR dark interface showing a synthetic search change and a line comment](docs/assets/review.png)

<p align="center"><sub>Demo code and fictional feedback.</sub></p>

Local review page for coding-agent changes. Agent publishes change set (one or more repos),
opens page, answers line comments from same conversation. **Ship it** makes agent open the PRs.

## Setup

Needs Docker with Compose, Git, Python 3.12+.

```bash
git clone https://github.com/demo-kode/prepr-tool.git
cd prepr-tool
mkdir -p .local/data
printf 'services:\n  review:\n    user: "%s:%s"\n' "$(id -u)" "$(id -g)" > compose.override.yaml
docker compose up -d --build
```

App listens on **http://127.0.0.1:18744** only. Data in `.local/data`.

Install skill:

```bash
ln -s "$(pwd)/skills/prepr-review" ~/.claude/skills/prepr-review   # Claude Code
ln -s "$(pwd)/skills/prepr-review" ~/.codex/skills/prepr-review    # Codex
```

## Flow

1. Work with agent as usual. Change set ready: agent creates PR branch in each affected repo,
   commits there (local only), writes manifest, publishes, offers to open PrePR.
2. Accept. Page opens. Top-right light green: **Agent watching**. Amber: **Agent working**
   (writing replies or changing code).
3. Comment on a line (click line number) or whole file.
4. Agent replies per thread, fixes code when asked, runs checks, commits fix round locally,
   republishes. Each open thread shows whose turn: *waiting for agent*, *agent writing reply /
   changing code*, *waiting for your reply*. Resolved threads collapse to one line (**Show**).
   **Open updated diff** loads new snapshot. Earlier threads stay visible on new code and in
   **Discussion**.
5. Finish, top right:
   - **Keep**: keep local changes, stop watching, delete review.
   - **Ship it**: agent pushes PR branches, opens real PRs (one per affected repo) for exact
     snapshot shown. Never merges or deploys.

Watching needs agent session alive. Session ended? Ask same agent to resume.
No live watch also works: tell agent to read feedback when done commenting.

## Page

| | |
| --- | --- |
| File marks | `+` added · `*` changed · `+m`/`*m` moved · `+c`/`*c` copied (`*` = edited) · ~~struck~~ deleted |
| Keys (file list) | ↑/↓ or W/S prev/next file · →/← or D/A viewed/unviewed |
| Filters | **Hide unchanged moves**, **Hide tests** (both on by default) |
| Views | Split, Unified, Raw (full file). Drag dividers to resize. |
| Tabs | **Files**, **Commits** (per repo, base to HEAD), **Discussion** (all threads) |
| Snapshots | Selector at top. Comments stay on code they were written against. Viewed marks carry over for files unchanged since previous snapshot. |

Moved/copied files compare against original content, also across repos. Header shows
`moved from …` / `copied from …`.

## Manifest (agent writes it)

```json
{
  "id": "search-timeout",
  "title": "Give slow searches time to finish",
  "description": "Adjust the API timeout and worker settings.",
  "repos": [
    {"name": "api", "path": "/abs/path/api", "branch": "fix/search-timeout", "base": "<base SHA>",
     "exclude": ["evidence/**"]},
    {"name": "worker", "path": "/abs/path/worker", "branch": "fix/search-timeout", "base": "<base SHA>"}
  ],
  "comparisons": [
    {"repo": "api", "path": "src/settings.py", "fromRepo": "worker", "fromPath": "shared/settings.py"}
  ]
}
```

- `base`: exact task start commit (merge-base for full PR). Keep across follow-ups.
- Snapshot covers `base` to current worktree: commits, staged, unstaged, untracked files.
- `include` / `exclude`: optional path globs. `branch` checked, never switched.
- `comparisons`: optional explicit source for copy or ambiguous move.

```bash
python3 review.py publish review.json           # new snapshot (identical content is reused)
python3 review.py feedback REVIEW_ID --open     # read open threads
```

## Data

Snapshots hold your source code. Keep `.local` private, untracked. Keep service on loopback:
no authentication. Reviews survive container rebuilds.

## Development

```bash
python3 -m unittest discover -s tests
```

Browser tests (`tests/*.cjs`) need Playwright and disposable server:
`PREPR_DATA=/tmp/prepr PORT=18745 python3 server.py`, then `node tests/sidebar.cjs` etc.
Never run against real service.
