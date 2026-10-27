# Pi setup

Personal [Pi](https://pi.dev) extensions and themes.

Development requires Node.js 22.6 or newer and the pnpm version pinned in
`package.json`.

## Structure

- `extensions/` — TypeScript extensions
- `lib/` — code shared by more than one extension
- `themes/` — JSON themes
- `tests/` — tests, mirroring the layout of `extensions/` and `lib/`

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
  in `settings.json` are respected. Recently and frequently used skills sort
  first; unused skills follow alphabetically.
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
provider/model, thinking level, context use, token counts, session cost,
cache-hit rate, and the active provider's Codex or OpenCode Go quota windows.
When subagents cost something, a separate `sub $…` segment shows their total.
It runs only in TUI mode.

Quota display is enabled by default. Configure it interactively with
`/statusline`, which opens a menu for toggling the Codex and OpenCode Go
quota sources, editing the OpenCode Go workspace ID, setting the auth token,
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

Codex uses Pi's `openai-codex` login.
OpenCode Go requires both the workspace ID and an auth token.
The workspace ID is sent as the `x-org-id` header; requests without it fail.
The auth token is the value of the `__Host-console_session` cookie
from a logged-in opencode.ai console session.
It goes in `~/.pi/agent/pi-statusline.auth.json` (or below `PI_CODING_AGENT_DIR`):

```json
{
  "opencodeGo": {
    "authToken": "token-value"
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
clipboard. Renames keep their destination path, tracked symlinks keep their
own path identity, and failed edit/write tool calls do not count as session
changes. The browser requires TUI mode.

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
commit`, branch switches, `git merge`, and `git pull`. Commands reached
through `xargs`, `find -exec`, `eval`, or wrappers like `nohup` are judged
like direct ones.
Every prompt and block message lists each risky step with the reason it was flagged.
A multi-line or otherwise complex command with a risky step is blocked
instead of shown, and the model is asked to run that step on its own.
Interactive sessions can approve or block commands and optionally provide a
reason when they abort one.
`/bash-guard stats` shows how often flagged commands ran or were rejected
in your saved sessions, by reason, with the reasons you gave. Non-interactive sessions fail closed unless
`bash-guard-auto-allow` is enabled. The subagents extension reuses this
policy in its `safe_bash` tool.

### Save Markdown

`extensions/save-md.ts` adds `/save-md name`, which writes the latest assistant
response to `name.md`. Relative paths use the current directory, subdirectories
and absolute paths are supported, and existing files are never overwritten.

### Web tools

`extensions/web-search/` adds `web_search` through Google Custom Search.
Set `GOOGLE_SEARCH_API_KEY` and `GOOGLE_CSE_ID` in the environment.
The tool supports exact phrases, exclusions, site restrictions, and up to ten results.

`extensions/web-fetch/` adds `web_fetch` for HTML, text, and PDF content.
It uses Readability for HTML and reads Next.js server-component payloads
when a page ships its text that way. It contacts only the requested URL;
there is no third-party reader fallback, so JavaScript-rendered pages fail
with an explicit error. Responses and model-visible output have explicit
size limits.

### Subagents

`extensions/subagents/` adds the `subagent` tool with single and parallel modes.
It provides scout, researcher, and worker agents in isolated Pi processes.
Add or override agents with Markdown files in `agents/` in the agent directory,
or per project in `.pi/agents/` (loaded only in trusted projects).
The most specific file wins by name: project over yours over the package.
The researcher receives only the web tools.
The worker receives file tools and `safe_bash`.
`safe_bash` blocks every command that bash-guard flags, and also
`git commit`, `git pull`, and `git stash`, which belong to the parent session.
A subagent that needs such a command asks the parent,
which runs it under bash-guard, so you still decide.
Subagents never ask you questions. An agent that needs an answer calls
`ask_parent`: its run ends with the question, and the parent model answers
by continuing the subagent's session, asking you only when it cannot.
Agent definitions cannot request the raw `bash` tool.
The extension depends on the web-fetch and web-search extensions and on the
shared bash policy in `lib/`. Removing one of them makes the agents that use
it fail when the extension loads.

Each run saves its session in `subagents/sessions/` below the agent directory,
apart from your normal sessions.
The tool result ends with `Session: <id>`.
Pass that id as `session` with a follow-up `task` to continue the subagent with its earlier context.
Expanding the tool result shows the subagent's whole conversation,
live while it runs, with the same components as the main chat.
With `background: true`, the tool returns at once.
The result arrives later as a message and starts a model turn,
or waits for the current one to end.
Background runs stop when the session closes; their sessions stay saved.
`/agents` lists this session's subagent runs, even while one runs.
Open a running subagent to follow it, send it a message
(Enter steers, Alt+Enter queues a follow-up), or stop it with Ctrl+X.
The parent model sees the messages you sent.
Each result and each `/agents` row shows what the run cost.
To work in a subagent session yourself, run `/agents open <id>`
or press Ctrl+O in `/agents`. It runs with your normal tools and extensions.
`/agents back` returns to the parent session and leaves the parent model
a note with the subagent's newest answer.

The optional config lives in `~/.pi/agent/subagents.json` (or below
`PI_CODING_AGENT_DIR` when set) and overrides the built-in defaults:
at most 4 subagents running at once across the session,
at most 8 parallel tasks in one call, sessions kept for 90 days,
and no model preferences.
Older sessions are deleted when Pi starts.
Each agent may set a `models` array of `provider/model` IDs.
The first available preferred model is selected. An agent without an available
preferred model inherits the parent model and thinking level.
A config entry for an agent without a matching package or user agent file
is an error.

```json
{
  "maxConcurrency": 4,
  "maxParallelTasks": 8,
  "sessionRetentionDays": 90,
  "agents": {
    "worker": {
      "models": ["provider/model-id", "other-provider/fallback-model"]
    }
  }
}
```

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

`pnpm test:tui` drives the real Pi TUI in a private tmux server against a fake
local model, so subagent runs, `/agents`, and the statusline are checked
on screen without cost or network. It needs tmux and is not part of
`pnpm check`. Its tests live in `tests/tui/` with the `.tui.ts` suffix.

## Install from Git

Once the repository has a remote, install it with:

```bash
pi install git:github.com/OWNER/REPOSITORY
```

Pi packages execute with the user's full permissions. Review changes before installing or updating them.
