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
  Skills appear in alphabetical order.
  The picker does not scan session history.
- `/skill-policy` controls which loaded skills the model may see and invoke on its own.
  Manual `/skill:name` commands still reach every skill.
  The policy fails closed: by default the model sees no skills,
  and a malformed policy also hides all skills.
- `/usage` takes no arguments and exports explicit native skill invocations from saved Pi session logs.
  It writes a unique timestamped JSON file under `<getAgentDir()>/skill-usage/`
  and shows the full path, invocation count, successful session count, and scan error count.
  `getAgentDir()` respects `PI_CODING_AGENT_DIR`.
  Malformed files appear in the report's errors; other files still scan.
  Reports never overwrite earlier reports and have no cleanup or latest pointer.
  History scans run only when you invoke `/usage`.
  The export contains metadata, not prompts, messages, or tool output.
  Historical body hashes come from saved expansions, not current skill files.
  See [`DESIGN.md`](extensions/skillset/DESIGN.md) for the schema and historical-format limits.

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

`extensions/files/` provides `/files`, also bound to `alt+o`.
It is a fuzzy-searchable picker over the current Git repository:
tracked and non-ignored untracked files with their Git status.
Dirty files sort first, then paths sort alphabetically.
Outside Git, it recursively lists every file under the working directory, including hidden and ignored files.
It does not scan session history.
Directories and special files are excluded.
File symlinks keep their own paths, and directory symlinks are not traversed.

Each opening starts with no files selected.
Use arrows to navigate, Tab to toggle checkboxes, and type to filter.
Space stays part of the search query.
The header shows the selected count, including files hidden by the current filter.

Enter appends all selected files as `@path` mentions to the existing draft and closes the picker.
With nothing selected, Enter adds the highlighted file directly.
Esc cancels without changing the draft.
Selection lasts only for that opening and does not read or update existing mentions.
Delete mentions manually in the editor when you no longer need them.

A renamed file keeps its destination path.
Deleted Git files and dangling symlinks remain selectable.
Discovery failures show an error instead of an incomplete list.
The picker requires TUI mode.

### Context

`extensions/context.ts` adds `/context`, a TUI overlay.
It shows estimated context categories, usage, cache and cost statistics,
and suggestions for compaction.
It requires TUI mode.

### Save Markdown

`extensions/save-md.ts` adds `/save-md name`.
It writes the latest assistant response to `name.md`.
Relative paths start from the current directory.
Subdirectories and absolute paths work too.
An existing file is never overwritten.

### Web tools

`extensions/web-search/` adds `web_search` through Brave Search API.
Create an API key with Web Search access at the [Brave API dashboard](https://api-dashboard.search.brave.com/).
Set it in the environment before starting Pi:

```bash
export BRAVE_SEARCH_API_KEY="your-api-key"
pi
```

Researcher inherits the same environment.
The tool supports exact phrases, exclusions, site restrictions, and up to ten results.
Brave handles these filters through search operators, which it documents as experimental.
The API key is sent in a request header, not in the search URL.
Google credentials are no longer used.
Restart Pi after changing the environment; `/reload` does not import variables from another shell.

`extensions/web-fetch/` adds `web_fetch` for HTML, text, and PDF content.
It uses Readability for HTML.
It also reads Next.js server-component payloads when a page delivers its text that way.
It contacts only the requested URL, and there is no third-party reader to fall back on.
A page that needs JavaScript to render therefore fails with an explicit error.
Responses and the output the model sees have explicit size limits.

### Background work

`extensions/background-work/` runs shell commands and subagents in the background.
Its two features load separately.
If one fails to load, a notice says why, and the other keeps working.

|                    | Shell job                             | Subagent                                     |
| ------------------ | ------------------------------------- | -------------------------------------------- |
| Start              | `task_start`                          | `subagent`                                   |
| Check              | `task_status`                         | `subagent_status`                            |
| Stop               | `task_stop`                           | `subagent_stop`                              |
| Default time limit | 30 minutes                            | 30 minutes                                   |
| Result arrives as  | a notice                              | a message, or the tool result in print mode  |
| When Pi closes     | stops, shown as interrupted on resume | stops, reported on resume                    |
| Config             | none                                  | `subagents.json`                             |

#### The `/tasks` view

Open `/tasks` with **Alt+T**. It lists shell jobs and subagents together:
active work of both kinds first, then shell history, then subagent history.
Each row shows the kind, the ID, the status with the elapsed time, and the title.
A subagent has one row per session, even while it runs, and continuing after `ask_parent` updates the same row.
Press Enter for details, `x` to stop the selected job or subagent, and Escape to go back or close.
Use `/tasks <id>` to open a job or subagent session directly. Completions name each entry's kind.
Job IDs show as a five-character prefix, extended when needed to be unique in the session.

A shell job's details show its command and log.
Press `c` for the full command, `w` to wrap lines, `/` or `?` to search, and End to follow new output.
A subagent's details show its continuous conversation, including earlier questions and parent answers.
History stays visible during streaming and after completion or reload, and PgUp/PgDn scroll it.
Unreadable history or a session file over 10 MiB shows a warning instead of a transcript.
There is no live steering or queued follow-up input.
Continue a session through the parent model's `subagent` call instead.

The footer counts running jobs after a `Tasks:` label,
and running or queued background subagents after a `Subagents:` label.

#### Shell jobs

`task_start` runs a shell command in the background and returns its job ID and log path.
A job runs as long as Pi does. Quitting Pi, `/reload`, or switching sessions stops it.
If Pi crashes, the job's own worker process stops it.
Finished jobs and their logs stay in the session's history.
A job that Pi's close cut short shows as interrupted when you resume the session.
The same session open in two Pi windows is not supported: each window can stop only its own jobs.
The default timeout is 30 minutes. Set `timeoutMs` to `0` for jobs that should run until stopped.
`task_status` lists the jobs of the current session, or shows one job with the last 20 lines of its log.
`task_stop` stops a job of the current session by job ID or unique prefix.
It waits up to 7 seconds for the job to end and reports its final state.
A stop takes about 5 seconds, because Pi waits that long before it kills the job's remaining processes.

**Do not append `&` to a command passed to `task_start`.** Pi already runs it in the background.
Use `npm test`, not `npm test &`.

Pi marks the task finished when its shell exits. If the shell leaves a child running,
Pi can no longer stop it from `/tasks` or enforce the task timeout.
If your script intentionally starts parallel workers with `&`, use `wait` to keep the shell alive until they finish.

In the terminal UI, a job completion reaches an active agent before its next model call or wakes an idle agent.
Requested stops, and jobs interrupted when Pi closed, show a notice without starting a turn.
RPC, print, and JSON modes save results without waking the agent.

Notice delivery is best effort. If Pi exits before it delivers a completion notice, the notice is lost.
The result and log remain available in `/tasks`.

#### Subagents

The `subagent` tool runs scout, researcher, and analyst agents in isolated Pi processes,
in single or parallel mode.
Only these built-in agents load.
User `agents/` and project `.pi/agents/` files are ignored, including overrides.

The scout reads code with `read`, `grep`, `find`, and `ls`.
The researcher uses the web tools.
The analyst independently investigates questions and assesses proposed solutions.
It stays read-only with the same tools as the scout.
All three can ask the parent with `ask_parent`.
Subagents have no editing or shell tools.
Changes and commands belong to the parent.
Subagents never ask you questions.
An agent that needs an answer calls `ask_parent`, and its run ends with the question.
The parent model answers by continuing the subagent's session,
and it asks you only when it cannot answer itself.

Subagents depend on the web-fetch and web-search extensions.
A missing tool extension or unsupported tool fails at load with the agent file path.

Each run saves its session in `subagents/sessions/` below the agent directory,
apart from your normal sessions.
The tool result ends with `Session: <id>`.
Pass that id as `session` with a follow-up `task` to continue the subagent with its earlier context.

Expanding a tool result shows only that run's conversation,
live while it runs, with the same components as the main chat.
The run mode decides whether the tool waits.
In the terminal and in RPC mode, subagents run in the background:
the tool returns at once with a run ID for each subagent.
In print and JSON mode, and in SDK sessions, which default to print mode, the tool waits and returns the results.
Pi exits after the answer in those modes, which would stop a background run.
Each run sends its own completion message, even when launched in parallel.
The message reaches a busy parent before its next model call, or starts a new turn if the parent is idle.
The parent can call `subagent_status` to list retained background runs or pass `runId` to inspect one without waiting.
It can call `subagent_stop` with a `runId` to stop a queued or running background run.
That tool waits up to 10 seconds for the run to end.
Both tools also accept `session` instead of `runId`.
A session selects its active run, or else its newest run.
A run stopped by the user or by `subagent_stop` delivers its result without starting a new turn.

Subagent runs default to a 30-minute runtime limit, starting when a run gets a slot.
Set `timeoutMs` at launch, or override it per entry in `tasks`. Use `0` to disable the limit.
On timeout, the run stops and reports `timed_out` with any captured partial output.
That output holds the last finished message, then the message that was still streaming, labeled "Unfinished message".
Background runs stop when the session closes, and their sessions stay saved.
When the session is opened again, one message lists the interrupted runs without starting a turn.
For each run, it says how to continue the subagent session, or to launch the run again if no session was saved.

Each tool result shows its run's cost.
Each subagent's detail header sums its retained runs once.
The registry retains every active run and the 50 newest finished runs.
Session grouping does not change the overall cost total.

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
Only `scout`, `researcher`, and `analyst` may appear under `agents`.
Malformed config and unknown agent names fail at load with the config path.

Migration: rename `agents.worker` to `agents.analyst` and remove other custom-agent config entries.
Custom agent files no longer load, and `/agents`, `/agents open`, `/agents back`, and Ctrl+O session switching are removed.
Use `/tasks` instead of `/agents`.
The `/tasks` shortcut is fixed to **Alt+T**, and `background-tasks.json` is no longer read.
No user config, agent files, or saved state are rewritten.
Historical results and transcripts remain readable, including old editing and shell calls.
Old worker or custom-agent sessions cannot continue because their definitions no longer exist.

```json
{
  "maxConcurrency": 4,
  "maxParallelTasks": 8,
  "sessionRetentionDays": 90,
  "agents": {
    "analyst": {
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
It checks subagent runs, `/tasks`, and the statusline on screen, with no cost and no network.
It needs tmux and is not part of `pnpm check`.
Its tests live in `tests/tui/` with the `.tui.ts` suffix.

## Install from Git

Once the repository has a remote, install it with:

```bash
pi install git:github.com/OWNER/REPOSITORY
```

Pi packages run with the user's full permissions.
Review changes before you install or update them.
