<div align="center">
  <img src="docs/assets/banner.svg" alt="PrePR — Catch the little things. Before the pull request." width="100%">
  <p><strong>Review your agent's work locally, before the pull request.</strong></p>
</div>

![PrePR dark interface showing a synthetic search change and a line comment](docs/assets/review.png)

<p align="center"><sub>Demo code and fictional feedback.</sub></p>

PrePR is a local review page for changes made by a coding agent. The agent publishes its
change set (one or more repositories), opens the page, and answers your line comments from
the same conversation. When you are satisfied, **Ship it** asks it to open the PRs.

## Setup

Needs Docker with Compose, Git and Python 3.12+.

```bash
git clone https://github.com/demo-kode/prepr-tool.git
cd prepr-tool
mkdir -p .local/data
printf 'services:\n  review:\n    user: "%s:%s"\n' "$(id -u)" "$(id -g)" > compose.override.yaml
docker compose up -d --build
```

The app listens on **http://127.0.0.1:18744** only. Data stays in `.local/data`.

Install the skill for your agent:

```bash
ln -s "$(pwd)/skills/prepr-review" ~/.claude/skills/prepr-review   # Claude Code
ln -s "$(pwd)/skills/prepr-review" ~/.codex/skills/prepr-review    # Codex
```

## How it works

1. Work with your agent as usual. When the change set is ready, the agent writes a review
   manifest, publishes it, and offers to open PrePR.
2. Accept. The page opens and the top-right dot turns green: the agent is watching.
3. Comment on any line (click the line number) or on a whole file.
4. The agent replies in each thread, fixes code when asked, runs checks and republishes.
   **Open updated diff** switches to the new snapshot. Earlier threads and replies stay
   visible on the new code (and always in **Discussion**).
5. Finish with one of the top-right actions:
   - **Keep** — keep the local changes, stop watching, delete the review.
   - **Ship it** — the agent creates one PR per affected repository for the exact snapshot
     shown. It never merges or deploys.

Watching lasts while the agent's session is active. If it ends, ask the same agent to resume.
Plain mode also works: tell the agent to read feedback when you are done commenting.

## Using the page

| | |
| --- | --- |
| File marks | `+` added · `*` changed · `+m`/`*m` moved · `+c`/`*c` copied (`*` = edited) · ~~struck~~ deleted |
| Keys (file list) | ↑/↓ or W/S previous/next file · →/← or D/A mark viewed/unviewed |
| Filters | **Hide unchanged moves**, **Hide tests** (both on by default) |
| Views | Split, Unified, Raw (full file). Dividers drag to resize. |
| Tabs | **Files**, **Commits** (per repository, base → HEAD), **Discussion** (all threads) |
| Snapshots | Selector at the top. Comments stay on the code they were written against. |

Moved and copied files compare against their original contents, even across repositories;
the header shows `moved from …` / `copied from …`.

## Manifest (written by the agent)

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

- `base`: exact commit the task started from (or the merge-base for a full PR). Keep it across follow-ups.
- The snapshot covers `base` → current worktree: commits, staged, unstaged and untracked files.
- `include` / `exclude`: optional path globs. `branch` is checked, never switched.
- `comparisons`: optional explicit source for a copy or ambiguous move.

```bash
python3 review.py publish review.json           # new snapshot (identical content is reused)
python3 review.py feedback REVIEW_ID --open     # read open threads
```

## Data

Snapshots contain your source code. Keep `.local` private and untracked, and the service on
loopback; there is no authentication. Reviews survive container rebuilds.

## Development

```bash
python3 -m unittest discover -s tests
```

Browser tests (`tests/*.cjs`) need Playwright and a disposable server:
`PREPR_DATA=/tmp/prepr PORT=18745 python3 server.py`, then `node tests/sidebar.cjs` etc.
Never run them against the real service.
