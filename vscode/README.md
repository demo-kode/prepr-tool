# PrePR for VS Code

Review your agent's changes before the pull request, right beside your code.
Same PrePR page (Files, Commits, Discussion, Keep, Ship it), in a slicker VS Code tab.

## Open a review

- Click **PrePR** in the status bar, pick a review.
- Or run **PrePR: Open review…** / **PrePR: Show all reviews** from the Command Palette.
- Agents open reviews for you: `vscode://demo-kode.prepr/open?review=ID`.

One tab per review, so parallel tasks sit side by side. Opening a review again brings its tab
forward. Tabs come back after a restart.
Outside links open in your browser.

## Setup

Needs the PrePR service running (default `http://127.0.0.1:18744`; setting `prepr.url`).
Install from the repo root: `python3 review.py vscode-install`.
