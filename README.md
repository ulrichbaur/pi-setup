# Pi setup

Personal [Pi](https://pi.dev) extensions, skills, prompt templates, and themes.

Development requires Node.js 22.6 or newer and pnpm 11.9.0.

## Structure

- `extensions/` — TypeScript extensions
- `themes/` — JSON themes
- `tests/` — tests for extensions and supporting code

## Extensions

### Clean startup header

`extensions/clean-header.ts` replaces Pi's built-in startup header with its
compact first two lines. It respects the active keybindings and runs only in
TUI mode.

Set `quietStartup` to `true` in
`$PI_CODING_AGENT_DIR/settings.json` if you also want to hide the
loaded-resource sections below the header. When the variable is unset, use
`~/.pi/agent/settings.json`.

### Skillset

`extensions/skillset/` combines three independently registered skill tools:

- `/skill` opens a searchable picker and queues a skill for the next message.
  It reads Pi's effective loaded skill collection, so package `skills` filters
  in `settings.json` are respected. Results currently sort alphabetically.
- `/skill-policy` controls which loaded skills the model may see and invoke
  automatically. Skills remain available through manual `/skill:name` commands.
  The policy is fail-closed: no skills are exposed by default, and a malformed
  policy also hides all skills.
- `/usage` opens a read-only survey of skill usage reconstructed from Pi session
  logs, including all-time per-skill and per-project counts plus 7/14/30/90-day
  trends. Session analysis failures are reported without disabling other tools.

Remove `npm:pi-skill-palette` from `settings.json` before enabling this
extension; otherwise Pi disambiguates the duplicate `/skill` commands.

The allowlist is stored in `skill-policy.json` below `PI_CODING_AGENT_DIR`, or
in `~/.pi/agent/skill-policy.json` when that variable is unset, with user-only
permissions. Delete it to restore the default empty allowlist. Run `/reload`
after installing or updating extensions; policy changes apply without a reload.

### Pi statusline

`extensions/pi-statusline/` replaces Pi's TUI footer with the active
provider/model, thinking level, context use, session cost, cache-hit rate, and
available Codex or OpenCode Go quota windows. It runs only in TUI mode.

Quota display is enabled by default. Configure it interactively with
`/statusline`, which opens a menu for toggling the Codex and OpenCode Go
quota sources, editing the OpenCode Go workspace ID, setting the auth cookie,
and previewing the current config. Changes are kept in memory until you
choose **Save & reload**; **Discard & exit** drops them. The menu re-reads the
on-disk config on open, so external edits show up correctly.

The non-secret config lives in `~/.pi/agent/pi-statusline.json` (or below
`PI_CODING_AGENT_DIR` when set):

```json
{
  "opencodeGo": {
    "workspaceId": "your-workspace-id"
  },
  "quotas": {
    "codex": true,
    "opencodeGo": true
  }
}
```

Codex uses Pi's `openai-codex` login. OpenCode Go additionally requires its
`auth` cookie value in `~/.pi/agent/pi-statusline.auth.json` (or below
`PI_CODING_AGENT_DIR`):

```json
{
  "opencodeGo": {
    "authCookie": "cookie-value"
  }
}
```

If you create the auth file manually, protect it with
`chmod 600 ~/.pi/agent/pi-statusline.auth.json`. Disable either quota source
by flipping its `quotas` value to `false` in the menu. Run `/reload` after
manually changing either file.

### Files

`extensions/files/` provides `/files` (also `ctrl+shift+o`), a fuzzy-searchable
browser over the current Git tree — tracked and untracked files with their Git
status — plus files referenced or edited in the session. Dirty files sort
first, then files changed this session, newest first. Selecting a file offers
actions to add an `@path` mention to the prompt or copy the path to the
clipboard. Pi changes also support viewing a diff, accepting changes, and
reverting changes when no external conflict exists. Renames keep their
destination path, tracked symlinks keep their own path identity, and failed
edit/write tool calls do not count as session changes. The browser requires TUI
mode.

### Context

`extensions/context.ts` adds `/context`, a TUI overlay with estimated context
categories, usage, cache and cost statistics, and compaction suggestions. It
requires TUI mode.

### Linked Markdown

`extensions/md-link.ts` adds a collaborative Markdown workflow. `/link-md path`
links a file and creates it when needed. `/unlink-md` removes the link.
`/send-diff` and `/sd` send external file changes as a user message. Final
assistant replies append to the linked file.

### Bash guard

`extensions/bash-guard/` reviews flagged Bash commands before execution.
It flags destructive or hard-to-recover operations such as `rm`, `sudo`,
`git reset --hard`, `git rebase`, and `git push`. It does not flag actions
the edit tools already allow, such as file redirects or `sed -i`, nor Git
operations that the index or reflog can undo, such as `git add`, `git
commit`, `git checkout`, `git merge`, and `git pull`.
Interactive sessions can approve or block commands and optionally provide a
reason when they abort one. Non-interactive sessions fail closed unless
`bash-guard-auto-allow` is enabled. The subagents extension reuses the
headless part of this policy in its `safe_bash` tool.

### Save Markdown

`extensions/save-md.ts` adds `/save-md name`, which writes the latest assistant
response to `name.md`. Relative paths use the current directory, subdirectories
and absolute paths are supported, and existing files are never overwritten.

### Web tools

`extensions/web-search/` adds `web_search` through Google Custom Search.
Set `GOOGLE_SEARCH_API_KEY` and `GOOGLE_CSE_ID` in the environment.
The tool supports exact phrases, exclusions, site restrictions, and up to ten results.

`extensions/web-fetch/` adds `web_fetch` for HTML, text, and PDF content.
It uses Readability for HTML and falls back to Jina Reader for dynamic pages.
Responses and model-visible output have explicit size limits.

### Subagents

`extensions/subagents/` adds the `subagent` tool with single and parallel modes.
It provides scout, researcher, and worker agents in isolated Pi processes.
The researcher receives only the web tools.
The worker receives file tools and `safe_bash`, which blocks common destructive system commands.
Agent definitions cannot request the raw `bash` tool.

`extensions/subagents/config.json` is required.
Each agent may set a `models` array of `provider/model` IDs there.
The first available preferred model is selected. An agent without an available
preferred model inherits the parent model and thinking level.
The same file controls concurrency and the maximum parallel task count.

## Develop locally

Install this checkout as a local Pi package:

```bash
pi install "$(pwd)"
```

After editing resources, run `/reload` inside Pi.

Enable the pre-commit hook once per checkout so `pnpm check` runs before
every commit:

```bash
git config core.hooksPath scripts/hooks
```

## Install from Git

Once the repository has a remote, install it with:

```bash
pi install git:github.com/OWNER/REPOSITORY
```

Pi packages execute with the user's full permissions. Review changes before installing or updating them.
