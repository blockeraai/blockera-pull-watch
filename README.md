# blockera-pull-watch

Central watcher for Blockera package-sync pull requests. It monitors `blockeraai` repositories for pull requests titled `Sync package from {REPO_NAME} Repo`, posts details to Slack, and removes the Slack message after the pull request is merged or closed.

## Watched repositories

Configured in [`config/repositories.json`](config/repositories.json):

- `blockeraai/blockera`
- `blockeraai/blockera-pro`
- `blockeraai/blockera-one`
- `blockeraai/blockera-site-toolkit`

## Pull request pattern

The watcher matches PR titles created by [`blockera-folder-sync`](https://github.com/blockeraai/blockera-folder-sync):

```text
Sync package from {REPO_NAME} Repo
```

Examples:

- `Sync package from blockera Repo`
- `Sync package from blockera-one Repo`

## Extracted PR data

For each matching pull request, the workflow tracks:

- PR ID (`number`)
- PR title
- PR status (`open`, `closed`, or `merged`)

## How it works

1. The GitHub Actions workflow runs every 10 minutes (and on manual dispatch).
2. It scans each configured repository for open PRs matching the title pattern.
3. New PRs trigger a Slack message with repository, PR ID, title, status, and a link.
4. When a tracked PR is merged, the corresponding Slack message is deleted.
5. Closed (not merged) PRs keep their Slack message with an updated status.
6. Slack message timestamps are stored in [`data/slack-messages.json`](data/slack-messages.json) so messages can be removed reliably across runs.

## Required GitHub secrets

Add these secrets in the `blockera-pull-watch` repository settings:

| Secret | Description |
| --- | --- |
| `BLOCKERABOT_PAT` | GitHub PAT with `repo` (or org read) access to the watched repositories |
| `SLACK_BOT_TOKEN` | Slack bot token (`xoxb-...`) with `chat:write` scope |
| `SLACK_CHANNEL_ID` | Target Slack channel ID (for example `C0123456789`) |

## Slack app setup

1. Create a Slack app in your workspace.
2. Add the `chat:write` bot scope.
3. Install the app to the workspace.
4. Invite the bot to the target channel.
5. Copy the bot token and channel ID into GitHub secrets.

## Manual run

Use **Actions → Watch Sync Package Pull Requests → Run workflow** to trigger a scan immediately.

After the first successful run, `data/slack-messages.json` is committed back to the repository. If this commit/push fails, reruns will post duplicate Slack messages because prior notifications are not tracked.

## Troubleshooting duplicate Slack messages

Duplicates usually mean state was not persisted between runs. Check the workflow log for the **Commit state changes** step and confirm:

1. `Loaded N tracked Slack message(s) from state.` shows `N > 0` on reruns
2. The commit step pushed `data/slack-messages.json` to `master`
3. `BLOCKERABOT_PAT` has write access to `blockera-pull-watch`

If duplicates were already posted, delete the extra Slack messages manually, then rerun once so the workflow can save the correct state.

## Optional instant updates

Other repositories can trigger an immediate scan with `repository_dispatch`:

```yaml
- name: Notify pull-watch
  uses: peter-evans/repository-dispatch@v3
  with:
      token: ${{ secrets.BLOCKERABOT_PAT }}
      repository: blockeraai/blockera-pull-watch
      event-type: sync-pr-updated
```

## Local testing

```bash
export GH_TOKEN="ghp_..."
export SLACK_BOT_TOKEN="xoxb-..."
export SLACK_CHANNEL_ID="C0123456789"

node scripts/watch-sync-prs.mjs
```
