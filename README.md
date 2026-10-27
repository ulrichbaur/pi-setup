# Pi setup

Personal [Pi](https://pi.dev) extensions and themes.

Development requires Node.js 22.6 or newer
and the pnpm version pinned in `package.json`.

## Structure

- `extensions/`: TypeScript extensions
- `lib/`: code shared by more than one extension
- `themes/`: JSON themes
- `tests/`: tests, mirroring the layout of `extensions/` and `lib/`;
  end-to-end TUI tests live in `tests/tui/`
- `scripts/hooks/`: the Git pre-commit hook

## Extensions

### Clean startup header

`extensions/clean-header.ts` replaces Pi's built-in startup header with its compact first two lines.
It respects the active keybindings.
It runs only in TUI mode.

To also hide the loaded-resource sections below the header,
set `quietStartup` to `true` in `$PI_CODING_AGENT_DIR/settings.json`.
When the variable is unset, use `~/.pi/agent/settings.json`.

### Skillset

`extensions/skillset/` combines three skill tools, and each one registers on its own:

- `/skill` opens a searchable picker and queues a skill for the next message.
  It reads the skills Pi has actually loaded,
  so package `skills` filters in `settings.json` apply.
  Recently and frequently used skills sort first.
  Unused skills follow in alphabetical order.
- `/skill-policy` controls which loaded skills the model may see and invoke on its own.
  Manual `/skill:name` commands still reach every skill.
  The policy fails closed: by default the model sees no skills,
  and a malformed policy also hides all skills.
- `/usage` opens a read-only survey of skill usage, rebuilt from Pi's session logs.
  It shows all-time counts per skill and per project,
  and trends over 7, 14, 30, and 90 days.
  A session that cannot be analyzed is reported, and the other tools keep working.

Remove `npm:pi-skill-palette` from `settings.json` before you enable this extension.
Otherwise Pi has two `/skill` commands and has to tell them apart.

The allowlist lives in `skill-policy.json` below `PI_CODING_AGENT_DIR`,
or in `~/.pi/agent/skill-policy.json` when that variable is unset.
Only your user may read or write the file.
Delete it to restore the default, empty allowlist.
Run `/reload` after you install or update extensions.
Policy changes apply without a reload.

### Pi statusline

`extensions/pi-statusline/` replaces Pi's TUI footer. It shows:

- the active provider and model, and the thinking level
- context use, token counts, session cost, and the cache-hit rate
- the quota windows of the active provider, for Codex or OpenCode Go
- when subagents cost something, their total in a separate `sub $…` segment

It runs only in TUI mode.

Quota display is on by default.
To configure it, run `/statusline`, which opens a menu.
There you turn the Codex and OpenCode Go quota sources on or off,
edit the OpenCode Go workspace ID, set the auth token, and preview the current config.
Changes stay in memory until you choose **Save & reload**.
**Discard & exit** drops them.
The menu reads the config from disk each time it opens, so it shows edits made elsewhere.

The non-secret config lives in `~/.pi/agent/pi-statusline.json`,
or below `PI_CODING_AGENT_DIR` when that variable is set:

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
It goes in `~/.pi/agent/pi-statusline.auth.json`, or below `PI_CODING_AGENT_DIR`:

```json
{
  "opencodeGo": {
    "authToken": "token-value"
  }
}
```

If you create the auth file by hand, protect it with `chmod 600 ~/.pi/agent/pi-statusline.auth.json`.
To disable a quota source, set its `quotas` value to `false` in the menu.
Run `/reload` after you change either file by hand.

### Files

`extensions/files/` provides `/files`, also bound to `ctrl+shift+o`.
It is a fuzzy-searchable browser over the current Git tree:
tracked and untracked files with their Git status,
plus files referenced or edited in the session.
Dirty files sort first, then files changed in this session, newest first.
For a selected file, you can add an `@path` mention to the prompt or copy the path to the clipboard.

A renamed file keeps its destination path.
A tracked symlink keeps its own path, not the path of its target.
Failed edit or write tool calls do not count as session changes.
The browser requires TUI mode.

### Context

`extensions/context.ts` adds `/context`, a TUI overlay.
It shows estimated context categories, usage, cache and cost statistics,
and suggestions for compaction.
It requires TUI mode.

### Linked Markdown

`extensions/md-link.ts` adds a collaborative Markdown workflow.
`/link-md path` links a file and creates it when needed.
`/unlink-md` removes the link.
`/send-diff` and `/sd` send changes made to the file outside Pi as a user message.
Final assistant replies are appended to the linked file.

### Bash guard

`extensions/bash-guard/` reviews flagged Bash commands before they run.
It flags destructive or hard-to-recover operations,
such as `rm`, `sudo`, `git reset --hard`, `git rebase`, and `git push`.
It does not flag what the edit tools already allow, such as file redirects or `sed -i`.
It also does not flag Git operations that the index or reflog can undo,
such as `git add`, `git commit`, branch switches, `git merge`, and `git pull`.
Commands reached through `xargs`, `find -exec`, `eval`, or wrappers like `nohup`
are judged like direct ones.

Every prompt and block message lists each risky step with the reason it was flagged.
A multi-line or otherwise complex command with a risky step is blocked
instead of shown, and the model is asked to run that step on its own.
In an interactive session, you approve or abort each flagged command,
and you may give a reason when you abort one.
Non-interactive sessions fail closed unless `bash-guard-auto-allow` is enabled.
The subagents extension reuses this policy in its `safe_bash` tool.

Each decision is recorded in `bash-guard/decisions.jsonl` below the agent directory.
`/bash-guard stats` shows how often flagged commands were approved or rejected,
by reason, with the reasons you gave, and estimates the same from older sessions.
Pass a copied log from another machine, as in `/bash-guard stats ~/work-decisions.jsonl`,
to count both together.

### Save Markdown

`extensions/save-md.ts` adds `/save-md name`.
It writes the latest assistant response to `name.md`.
Relative paths start from the current directory.
Subdirectories and absolute paths work too.
An existing file is never overwritten.

### Web tools

`extensions/web-search/` adds `web_search` through Google Custom Search.
Set `GOOGLE_SEARCH_API_KEY` and `GOOGLE_CSE_ID` in the environment.
The tool supports exact phrases, exclusions, site restrictions, and up to ten results.

`extensions/web-fetch/` adds `web_fetch` for HTML, text, and PDF content.
It uses Readability for HTML.
It also reads Next.js server-component payloads when a page delivers its text that way.
It contacts only the requested URL, and there is no third-party reader to fall back on.
A page that needs JavaScript to render therefore fails with an explicit error.
Responses and the output the model sees have explicit size limits.

### Subagents

`extensions/subagents/` adds the `subagent` tool with single and parallel modes.
It provides scout, researcher, and worker agents in isolated Pi processes.
Add or override agents with Markdown files in `agents/` in the agent directory,
or per project in `.pi/agents/`, which load only in trusted projects.
The most specific file wins by name: project over yours over the package.

The scout reads code with `read`, `grep`, `find`, and `ls`.
The researcher uses the web tools.
The worker receives file tools and `safe_bash`.
All three can ask the parent with `ask_parent`.
Agent definitions cannot request the raw `bash` tool.

`safe_bash` blocks every command that bash-guard flags, and also
`git commit`, `git pull`, and `git stash`, which belong to the parent session.
A subagent that needs such a command asks the parent,
which runs it under bash-guard, so you still decide.
Subagents never ask you questions.
An agent that needs an answer calls `ask_parent`, and its run ends with the question.
The parent model answers by continuing the subagent's session,
and it asks you only when it cannot answer itself.

The extension depends on the web-fetch and web-search extensions
and on the shared bash policy in `lib/`.
If one of them is missing, the extension fails when it loads.

Each run saves its session in `subagents/sessions/` below the agent directory,
apart from your normal sessions.
The tool result ends with `Session: <id>`.
Pass that id as `session` with a follow-up `task` to continue the subagent with its earlier context.

Expanding the tool result shows the subagent's whole conversation,
live while it runs, with the same components as the main chat.
With `background: true`, the tool returns at once.
The result arrives later as a message and starts a model turn,
or it waits for the current turn to end.
Background runs stop when the session closes, and their sessions stay saved.

`/agents` lists this session's subagent runs, even while one runs.
Open a running subagent to follow it, send it a message, or stop it with Ctrl+X.
To send a message, Enter steers it and Alt+Enter queues a follow-up.
The parent model sees the messages you sent.
Each result and each `/agents` row shows what the run cost.

To work in a subagent session yourself, run `/agents open <id>` or press Ctrl+O in `/agents`.
The session runs with your normal tools and extensions.
`/agents back` returns to the parent session
and leaves the parent model a note with the subagent's newest answer.

The optional config lives in `~/.pi/agent/subagents.json`,
or below `PI_CODING_AGENT_DIR` when that variable is set.
It overrides these built-in defaults:

- at most 4 subagents running at once across the session
- at most 8 parallel tasks in one call
- sessions kept for 90 days; older ones are deleted when Pi starts
- no model preferences

Each agent may set a `models` array of `provider/model` IDs.
The first preferred model that is available is selected.
An agent without an available preferred model inherits the parent model and thinking level.
A config entry for an agent without a matching package or user agent file is an error.

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

After you edit resources, run `/reload` inside Pi.

Enable the pre-commit hook once per checkout.
It runs `pnpm check` before every commit:

```bash
git config core.hooksPath scripts/hooks
```

`pnpm test:tui` drives the real Pi TUI in a private tmux server, against a fake local model.
It checks subagent runs, `/agents`, and the statusline on screen, with no cost and no network.
It needs tmux and is not part of `pnpm check`.
Its tests live in `tests/tui/` with the `.tui.ts` suffix.

## Install from Git

Once the repository has a remote, install it with:

```bash
pi install git:github.com/OWNER/REPOSITORY
```

Pi packages run with the user's full permissions.
Review changes before you install or update them.
