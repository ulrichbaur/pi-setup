# Background work

One extension with two features: shell jobs in `tasks/` and subagents in `subagents/`.
The subagent design is in `subagents/DESIGN.md`.

## Layout

- `tasks/` and `subagents/` never import from each other.
- `index.ts`, `view.ts`, `rows.ts`, and `pane.ts` sit above both features and may use either.
- `index.ts` registers each feature on its own.
  A feature that throws at load is reported at `session_start`, and the other keeps working.
  Its section in `/tasks` shows the error instead of rows.
- Each register function returns a handle with what the view needs, such as its registry.

## Shell job lifecycle

- A job's record is `job.json` in its own folder, with `output.log` next to it.
  Pi writes the record when the job starts and when it ends.
- Pi starts one worker per job, detached into its own process group, with an IPC channel.
  The worker starts `/bin/sh -c` in a further process group of its own, and writes its output to the log.
  The `JobRegistry` in Pi owns the worker and enforces the timeout.
- A stop asks the worker to send `SIGTERM` to the shell's group.
  The worker checks every 50 ms whether the group has a process left,
  and sends `SIGKILL` after 5 seconds if one remains.
  Once the group is empty, it reports `stopped` to Pi and exits.
- The worker stays outside the shell's group, so it can tell when the group is empty.
  It stops signalling as soon as the group is gone.
  A process ID is not reused while its group exists, so it never signals a reused group.
- After a normal exit, Pi releases the worker.
  A child that the shell left running keeps running and is no longer controlled.
- Jobs end with Pi.
  Session shutdown stops every job this Pi owns.
- When the IPC channel closes before a release, Pi is gone.
  The worker then records the end itself and stops its group.
  A job that was stopping, or still running, becomes `interrupted`.
  A shell that ended on its own keeps its exit code.
- A send to a closed channel passes a callback.
  Without one, the error crashes the worker, which then records nothing and leaves processes behind.
- At `session_start`, Pi reads the session's records once.
  A record without an end, not owned by this Pi, and without a live worker becomes `interrupted`.
  Its end time is the last write to its log.
  Each interrupted job gets one notice without a turn, and its record notes that the notice was sent.
- Two Pi windows on one session are not supported.
  A later window can mark the other window's running job `interrupted`.

## Guards

- A sent message joins the branch that is current when it is sent,
  so a result can land on another branch than the one that started the work.
- `guard.ts` asks before `/tree` moves while shell jobs or background subagents run,
  and before `/new`, `/resume`, `/fork`, or `/clone` leave the session, which stops them.
  Answering No cancels the move.
- Without dialogs, as in print mode, nothing asks.
  Pi has no hook before `/reload` or quitting.

## Notices

- A job's end sends a notice at once, in the terminal UI only.
  A requested stop and an interruption do not start a turn; other ends do.
- Delivery is best effort.
  A notice lost when Pi exits is not sent again.

## The view

- `/tasks` and **Alt+T** open `BackgroundView`.
  It lists active work of both kinds, newest first, then shell history, then subagent history.
- Shell rows come from the job records.
  The view reloads them when the `JobRegistry` reports a change.
- Subagent rows come from the run registry, one per session.
  The view redraws when the run registry changes.
- One 600 ms timer moves elapsed times and lets an open log follow its output.
  Log growth fires no registry event.
- A detail pane draws only its content.
  The view draws the frame and places the pane's notice above its key hints.
- In a pane, Escape returns to the list.
  In the list, Escape closes the view.
