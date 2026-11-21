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
  A missing file or a file over 10 MiB shows a warning.
  Expanded tool results fall back to the final output.
- When a run ends, tool rows still showing a partial result get a final one,
  so their redraw timers stop.

## View

- `/tasks` shows subagents next to shell jobs (see `../view.ts`).
  It groups the registry into one display row per subagent session,
  ordered by newest run first.
  A saved result without a session id is skipped when the session loads.
  The registry still keeps every active run and the 50 newest finished runs.
  Grouping does not mutate per-run results or cost-event bookkeeping.
  The active run supplies the status and cancellation target;
  otherwise the newest run supplies the status.
- A reload or a session switch replaces the extension runtime,
  so `session_start` rebuilds the finished runs from the session branch:
  foreground tool results and delivered background results.
  A background run that never delivered ended with its session
  and shows as `interrupted`.
  Extension commands run while Pi streams, so it opens during a run.
- A session opens to its continuous transcript, which follows new output
  until the user scrolls up.
  Resuming after `ask_parent` keeps the same row and selection.
  Earlier questions and parent answers remain in chronological order.
  While streaming, saved messages before the active run's `messageStart`
  precede that run's RPC messages and partial response, without overlap.
  After completion or restoration, the view reads from message zero
  through the newest run's `messageEnd`.
  A pending continuation shows the preceding saved history.
  Unreadable history or a file over 10 MiB shows a visible warning.
  Expanded tool results keep their individual run ranges.
- Both running and finished transcripts are read-only.
  PgUp/PgDn scroll the transcript.
  There is no input line, steering, queued follow-up, or session switching.
  Escape returns to the list and then closes the overlay.
- Continuing a session belongs to the parent model through `subagent(session, task)`.
- Transcripts render the subagent tools with Pi's own renderers.
  Any other tool call renders in the generic tool format.
- `x` stops the selected session's active run, even if the detail view
  opened before that run started.
  The other runs of the same tool call continue,
  and the stopped one ends as `stopped` with "Stopped by the user".
- A run ends as `stopped` when the user, `subagent_stop`, or an aborted tool call stops it,
  and as `interrupted` when its session closes.
  Neither counts as a failure, so both show in a muted color.

## Background

- `maxConcurrency` limits all runs of the session at once,
  across tool calls and background runs, first come, first served.
  A waiting run shows as pending, and stopping it leaves the queue.
- The run mode decides between background and foreground; the model does not choose.
  In `tui` and `rpc` mode, the client stays open for later messages, so runs go to the background.
  In `print` and `json` mode, Pi exits after the answer, which would stop a background run,
  so the tool waits. SDK sessions default to `print`.
  The same time limit applies in every mode.
- A background launch returns at once with a unique ID per run and its session ID.
  The runs outlive the tool call, so its abort signal does not stop them.
  `/tasks`, `subagent_stop`, and session shutdown can stop them.
- The saved tool result lists which runs started, not their progress.
  A snapshot would show them running forever after a reload.
- Each run sends one custom completion message, even if other runs from the same call are still active.
  Pi delivers it at the next steering boundary when the parent is busy, or starts a turn when it is idle.
- The `subagent_status` tool reads a snapshot by run ID or lists all retained background runs.
  It and `subagent_stop` also accept a session ID.
  A session has at most one active run, so it resolves to that run, or else to its newest run.
  Looking up a run does not affect delivery.
  The TUI status line counts running and queued background runs.
- The `subagent_stop` tool stops one background run by run ID and waits up to 10 seconds for it to end.
  The abort reason records who stopped the run, the user or the parent agent.
  A stopped run still delivers its result message, so restore and cost tracking stay the same.
  That message does not start a turn, whoever stopped the run.
  The user chose to stop it, or the `subagent_stop` result already reports the outcome.
  A timeout is not a stop, so its result still starts a turn.
- A background run gets a 30-minute timeout when it takes a concurrency slot.
  A launch can override `timeoutMs` for all tasks or for an individual task; `0` disables it.
  A timeout stops the child and uses the same delivery path as other results.
  Its output joins the last finished message and the streaming one, both read when the timer fires.
  Pi's abort ends the streaming message with the same text, so a later read would repeat it.
  Once the child reports settlement, the timer no longer applies to cleanup.
- A session shutdown stops the background runs
  and cancels their delivery, so a late result never reaches another session.
  Their subagent sessions stay saved for a resume.
- At `session_start`, background launches in the branch without a saved result were interrupted.
  One message reports them, without starting a turn, and says how to continue each subagent session.
  A run without a saved session file can only be launched again.
  The message is sent after the handler returns.
  Once it is saved, it pairs each launch with a result, so the next start sends nothing.
- A run that throws becomes a failed result,
  so every run reaches a final status and the call always delivers.

## Cost

- Each result header shows the run's cost.
  Each session's row and detail header in `/tasks` sum the retained runs of its session once,
  deduplicated by the same result key as cost events.
  Tool counts and durations also sum those retained runs.
  Evicted runs can still appear in the saved transcript but not in row totals.
- The extension reports the total on the event bus channel
  `subagents:cost`, defined in `lib/subagent-cost.ts`.
  Other extensions only listen; none imports this one.
- The total is the saved results on the current branch,
  plus every run of this runtime whose result is not saved yet.
  A finished run therefore counts before Pi saves its result.
- Pi shows extensions a message before it saves it,
  so a subagent result counts from its `message_end` on.
- A run interrupted when Pi closed never reports its usage.
  On resume, its interrupted result sums the usage Pi saved with each assistant message
  in the child's session file, from the end of that session's last saved result on.
  The result also gets that message range, so its transcript can be shown.
  A file that cannot be read leaves the cost at zero and says so in the result.
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
- One session runs in at most one child at a time.
  The extension tracks the ids of running sessions,
  and a request for a running session fails.
- A resume rejects a `cwd` and an agent that does not match the id.
- Each result ends with `Session: <id>`, so the parent model can resume it.
- Sessions older than `sessionRetentionDays` (default 90) are deleted at startup.
  A cleanup failure shows a notice and does not stop the extension.
