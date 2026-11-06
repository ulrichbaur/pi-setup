# Subagents

- A subagent is a child Pi process in RPC mode.
  The parent sends commands on stdin and reads events on stdout.
- Each subagent keeps a saved session.
  The parent model can resume it, and the user can open it with `pi --session <path>`.

## Agents

- Built-in agents are scout for codebase recon, researcher for web research,
  and analyst for general-purpose independent analysis.
  Analyst uses the same read-only tools as scout: `read`, `grep`, `find`, `ls`,
  and `ask_parent`.
  Researcher gets `web_search`, `web_fetch`, and `ask_parent`.
  No subagent gets editing or shell tools.
- The loader reads only the three named package Markdown files.
  External user and project agent files are never discovered or read.
  There are no overrides or agent-specific trust decisions.
- A malformed package definition, unsupported tool, or missing tool extension
  fails the load with the definition path.
- Optional `subagents.json` config selects model preferences for built-ins
  and sets concurrency, parallel task, and retention limits.
  Missing config uses defaults silently.
  Malformed config or an unknown agent name fails with the config path.
- Migration: rename `agents.worker` to `agents.analyst` and remove other
  custom-agent config entries.
  There is no worker alias and no custom-agent support.
  User files and saved state are not rewritten.

## Transport

- Start the child with the same Pi binary as the parent, in `--mode rpc`.
  Skills and discovered extensions stay off;
  the agent's custom tools load with `--extension`.
- Use our own small client, not Pi's `RpcClient`.
  That client always spawns `node`, copies child stderr into the parent terminal,
  and stops waiting after 60 seconds.
- Split stdout on LF only and decode UTF-8 across chunk boundaries.
  JSON strings may contain U+2028 and U+2029.
- Send the task with the `prompt` command.
  A rejected prompt, or one an input handler consumed, fails the run.
- A run ends at `agent_settled`, not `agent_end`.
  Retries and compaction can follow `agent_end`.
- After the run, close stdin.
  Pi then shuts down and finishes writing the session.
- On abort, send the `abort` command, then close stdin.
  Signals are only a fallback when the child does not exit.
- A child that exits before `agent_settled` fails the run and shows its stderr.
- A child that reached `agent_settled` but had to be stopped with a signal
  keeps its answer and gets a warning with its stderr.
  Pi writes each session entry at once, so the session is complete.
- A successful turn clears the error of an earlier failed turn,
  because Pi's retry recovered.
  A retry that finally fails sets the run's error.

## Safety and questions

- Subagents have no user to ask.
  Every child dialog gets a cancel response, so no child waits on one.
  With a parent UI, child notifications appear there,
  prefixed with the session id.
- Editing and shell execution belong to the parent.
  Child tool selection permits only file inspection, web research, and questions.
- Subagents do not ask the user questions.
  `ask_parent` ends the run with `terminate: true`, so the question
  is the run's last word, and the result tells the parent model
  to answer by continuing the session.
  A later assistant turn clears the question,
  because the run went on without the answer.

## Transcript

- The collapsed result shows recent tools and the last message.
- The expanded result shows the run's conversation
  with the components of Pi's main chat.
  Thinking blocks follow the user's `hideThinkingBlock` setting,
  read at each render, so a toggle applies at once.
- While a run streams, the transcript is built from RPC events
  and lives only in memory.
- The saved result keeps the session file and the run's range of message
  entries, not the messages.
  Expanding it reads that range from the file.
  A missing file shows a warning, and the result falls back to the final output.
- When a run ends, tool rows still showing a partial result get a final one,
  so their redraw timers stop.

## Overlay

- `/agents` lists the subagent runs of this session, newest first.
  It keeps every running run and the 50 newest finished ones.
- A reload or a session switch replaces the extension runtime,
  so `session_start` rebuilds the finished runs from the session branch:
  foreground tool results and delivered background results.
  A background run that never delivered ended with its session
  and shows as stopped.
  Extension commands run while Pi streams, so it opens during a run.
- A run opens to its transcript, which follows new output
  until the user scrolls up.
- Both running and finished transcripts are read-only.
  PgUp/PgDn scroll the transcript.
  There is no input line, steering, queued follow-up, or session switching.
  Escape returns to the list and then closes the overlay.
- Continuing a session belongs to the parent model through `subagent(session, task)`.
- Historical results retain custom-agent provenance and user messages for display.
  Historical editing and shell calls retain their transcript renderers,
  but these tools are not registered or available to children.
- Ctrl+X stops one run.
  The other runs of the same tool call continue,
  and the stopped one fails with "Stopped by the user".

## Background

- `maxConcurrency` limits all runs of the session at once,
  across tool calls and background runs, first come, first served.
  A waiting run shows as pending, and stopping it leaves the queue.
- With `background: true`, the tool returns at once with the session ids.
  The runs outlive the tool call, so its abort signal does not stop them;
  `/agents` and session shutdown do.
- The saved tool result lists which runs started, not their progress.
  A snapshot would show them running forever after a reload.
- When all runs of the call end, one custom message carries the results.
  For results that arrive one by one, the model starts each task
  in its own background call.
  The message starts a turn when the parent is idle
  and follows the current run when it is busy.
- A session shutdown stops the background runs
  and cancels their delivery, so a late result never reaches another session.
  Their subagent sessions stay saved for a resume.
- A run that throws becomes a failed result,
  so every run reaches a final status and the call always delivers.

## Cost

- Each result header and each `/agents` row shows the run's cost.
- The extension reports the total on the event bus channel
  `subagents:cost`, defined in `lib/subagent-cost.ts`.
  Other extensions only listen; none imports this one.
- The total is the saved results on the current branch,
  plus every run of this runtime whose result is not saved yet.
  A finished run therefore counts before Pi saves its result.
- Pi shows extensions a message before it saves it,
  so a subagent result counts from its `message_end` on.
  Results count once, matched by agent, session id, and message range.
- The total is reported only when it changes.

## Sessions

- Sessions live in `subagents/sessions` below Pi's agent directory.
  They stay out of `/resume` and out of the skillset history,
  which read Pi's default session directory.
- The extension creates each id as `<agent>-<8 hex characters>`.
  The agent name in the id tells a resume which definition to load.
  Agent names therefore contain only letters, digits, `_`, and `-`.
- The session name is `<agent>: <start of the task>`.
- The parent's tool result stores the session id and file.
  That is the only link between parent and child.
- A resume finds `*_<id>.jsonl`, reads the working directory from its header,
  and starts the child there with `--session <path>`.
  The built-in agent's current definition and model selection apply.
  Old worker or custom-agent sessions fail clearly because their agent is unknown.
  Their stored results and transcripts remain readable.
- One session runs in at most one child at a time.
  The extension tracks the ids of running sessions,
  and a request for a running session fails.
- A resume rejects a `cwd` and an agent that does not match the id.
- Each result ends with `Session: <id>`, so the parent model can resume it.
- Sessions older than `sessionRetentionDays` (default 90) are deleted at startup.
  A cleanup failure shows a notice and does not stop the extension.
