# blockera-pull-watch

Central watcher for Blockera package-sync pull requests. It monitors `blockeraai`
consumer repositories, posts matching PRs to Slack, and removes the Slack
message after a pull request is merged or closed.

It watches two kinds of PRs:

1. Folder-sync titles from [`blockera-folder-sync`](https://github.com/blockeraai/blockera-folder-sync)
2. Global-packages bump PRs from consumer
   `sync-global-packages-submodule.yml` (`chore/bump-global-packages`, title
   `submodule: update global-packages`)

## Watched repositories

Configured in [`config/repositories.json`](config/repositories.json):

- `blockeraai/blockera`
- `blockeraai/blockera-pro`
- `blockeraai/blockera-one`
- `blockeraai/blockera-site-toolkit`

## Pull request matchers

Matchers live in `config/repositories.json` (`matchers`). A PR matches if its
**head branch** equals `head` **or** its title matches `titlePattern`.

| Kind | How it matches | Slack header |
| --- | --- | --- |
| Folder sync | Title `Sync package from {REPO_NAME} Repo` | Package Sync Pull Request |
| Global-packages bump | Head `chore/bump-global-packages`, or title starting with `submodule: update global-packages` (covers older titles that also had a commit count / gitlink) | Global Packages pin (paired fields, pin SHA, Review / Checks / GP commit) |

## Extracted PR data

For each matching pull request, the workflow tracks:

- PR ID (`number`)
- PR title
- PR status (`open`, `closed`, or `merged`)
- For global-packages bump PRs: head branch, GP pin SHA (from the PR body), draft flag

## How it works

1. The GitHub Actions workflow runs every 10 minutes (and on manual dispatch).
2. It scans each configured repository for open PRs matching the configured matchers.
3. New PRs trigger a Slack message. Global-packages bump PRs use a two-column layout (consumer, PR, head, GP pin, base, author) plus Review / Checks / GP commit buttons.
4. When a tracked PR is merged **or closed**, the corresponding Slack message is deleted.
5. Slack message timestamps are stored in [`data/slack-messages.json`](data/slack-messages.json) so messages can be removed reliably across runs.

## Required GitHub secrets

Add these secrets in the `blockera-pull-watch` repository settings:

| Secret | Description |
| --- | --- |
| `BLOCKERABOT_PAT` | GitHub PAT with `repo` (or org read) access to the watched repositories |
| `SLACK_BOT_TOKEN` | Slack bot token (`xoxb-...`) with `chat:write` scope |
| `SLACK_CHANNEL_ID` | Target Slack channel ID (for example `C0123456789`) |

## Slack app setup

1. Create a Slack app in your workspace.
2. Add the `chat:write` and `channels:history` bot scopes.
3. Install the app to the workspace.
4. Invite the bot to the target channel.
5. Copy the bot token and channel ID into GitHub secrets.

If a notification is deleted manually in Slack, the next workflow run detects the missing message and posts it again.

## Manual run

Use **Actions → Watch Sync Package Pull Requests → Run workflow** to trigger a scan immediately.

After the first successful run, `data/slack-messages.json` is updated via the GitHub Contents API. If this push fails, reruns will post duplicate Slack messages because prior notifications are not tracked.

Do not revert commits titled `bot(watch): update slack message state`. Those commits store Slack message IDs required to avoid duplicate notifications.

## Troubleshooting duplicate Slack messages

Duplicates usually mean state was not persisted between runs. Check the workflow log for the **Push state changes** step and confirm:

1. `Loaded N tracked Slack message(s) from remote state` shows `N > 0` on reruns
2. The push step logged `State pushed successfully`
3. `BLOCKERABOT_PAT` has write access to `blockera-pull-watch`
4. The latest `data/slack-messages.json` on `master` was not reverted manually

If duplicates were already posted, delete the extra Slack messages manually, then rerun once so the workflow can save the correct state.

To sync state locally after a workflow run:

```bash
git pull origin master
```

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
