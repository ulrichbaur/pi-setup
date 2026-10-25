# Subagents

- A subagent is a child Pi process in RPC mode.
  The parent sends commands on stdin and reads events on stdout.
- Each subagent keeps a saved session.
  The parent model can resume it, and the user can open it with `pi --session <path>`.

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

## Dialogs

- With a parent UI, a child's `select`, `confirm`, `input`, and `editor` requests
  open in the parent, titled with the session id.
  Notifications appear there too; other UI requests are ignored.
- A background run opens no dialog over the user's work.
  Its requests wait in `/agents`, marked on the run, and the user gets a notice.
  A request is cancelled after `backgroundQuestionTimeoutMinutes` (default 10),
  after the child's own timeout, or when the run stops.
- One dialog is open at a time, across all subagents.
  A dialog whose child exited, whose run was aborted,
  or whose timeout passed while it waited is never shown.
  An open one, except the editor, closes when its child exits
  or its run is aborted.
- Without a parent UI, every dialog gets a cancel response.
- With a parent UI, the parent starts `safe_bash` with `--safe-bash-ask`.
  The user then decides about every command
  that the headless or the interactive policy catches.
  A refusal or a dismissed dialog blocks the command.
  Without the flag, the headless policy decides alone.
- Every agent has `ask_user`.
  Without an answer, the tool tells the agent to continue
  and state its assumption.

## Transcript

- The collapsed result shows recent tools and the last message.
- The expanded result shows the run's conversation
  with the components of Pi's main chat.
- While a run streams, the transcript is built from RPC events
  and lives only in memory.
- The saved result keeps the session file and the run's range of message
  entries, not the messages.
  Expanding it reads that range from the file.
  A missing file shows a warning, and the result falls back to the final output.
- When a run ends, tool rows still showing a partial result get a final one,
  so their redraw timers stop.

## Overlay

- `/agents` lists the subagent runs of this Pi process, newest first.
  It keeps every running run and the 50 newest finished ones.
  Extension commands run while Pi streams, so it opens during a run.
- A run opens to its transcript, which follows new output
  until the user scrolls up.
- A running subagent takes messages from the input line:
  Enter steers it after its current turn,
  and Alt+Enter queues a follow-up for when it would stop.
  The input clears on send and gets the text back if sending fails.
- The tool result lists the user's messages,
  so the parent model knows why the output may differ from its request.
- A child stops taking messages at `agent_settled`,
  because a message sent after it would never run.
- A finished run is read-only.
  Continuing it belongs to the parent model through its session id.
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
  It starts a turn when the parent is idle
  and follows the current run when it is busy.
- A session shutdown stops the background runs
  and cancels their delivery, so a late result never reaches another session.
  Their subagent sessions stay saved for a resume.
- A run that throws becomes a failed result,
  so every run reaches a final status and the call always delivers.

## Opening a session

- `/agents open <id>`, or Ctrl+O in the overlay,
  switches this Pi to a saved subagent session.
  `/agents back` switches to the session it was opened from.
- The opened session runs with the user's normal setup:
  tools, skills, extensions, and bash-guard.
  The agent's role prompt does not apply there.
- A switch replaces the extension runtime, so the way back lives in
  `subagents/returns.json` below the agent directory.
  It maps each opened session to its parent and to the session's
  message count at opening.
- Opening needs an idle Pi and a saved parent session.
- Opening closes the parent session, which stops its running subagents.
  The user confirms first, and the switch waits until their sessions are
  complete, so two writers never share a file.
- When the opened session grew, going back leaves the parent model a note
  with the newest answer and the session id.
  The note joins the next turn and starts none.

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
  The agent's current definition and model selection apply.
- One session runs in at most one child at a time.
  The extension tracks the ids of running sessions,
  and a request for a running session fails.
- A resume rejects a `cwd` and an agent that does not match the id.
- Each result ends with `Session: <id>`, so the parent model can resume it.
- Sessions older than `sessionRetentionDays` (default 90) are deleted at startup.
  A cleanup failure shows a notice and does not stop the extension.
