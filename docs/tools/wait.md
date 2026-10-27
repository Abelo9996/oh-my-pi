# wait

> Block until the next background result, peer message, or steering interrupt when there is no other work to do.

## Source
- Entry: `packages/coding-agent/src/tools/wait.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/wait.md`
- Job delivery: `packages/coding-agent/src/async/job-manager.ts`

## Input and availability
`wait` has no arguments. It is an essential, read-approved, interruptible tool available when async jobs, peer messaging, or supervised services are enabled; it does not select a particular peer or job.

## Behavior
- Returns on the first settled caller-owned job or incoming peer message. Job results delivered by this call are consumed so no duplicate async-result follows.
- A steering/tool interrupt returns `Wait interrupted by message.` with `details.interrupted=true`; other aborts propagate. Handle the incoming notice before calling `wait` again.
- Every wait has a 30-minute safety cap. There is no caller-selectable timeout.
- With no owned job or service running, `wait` blocks for outstanding direct requests sent during the caller's current run. Each request is identified by its message id. A final reply sent with `write agent://<sender>?replyTo=<incoming-message-id>` fulfills only that request; a correlated reply is not itself another request. A settled job running the requested agent for the caller also answers existing requests (spawn and wake jobs included).
- Any incoming message returns immediately, but an interim acknowledgement or unrelated message without `replyTo` does not fulfill an outstanding request. After consuming it, a later `wait` can block again, even if the peer went idle and wakes later. Compatibility: a peer that answers with a plain `write agent://<sender>` no longer discharges the request; a subsequent `wait` may block for the existing 30-minute cap. Use `replyTo` only on final replies, not on progress.
- Explicit peer cancellation, removal, or unavailability ends its outstanding requests. Dependency cycles still end a reply wait without an error: the requested peer cannot answer before the caller finishes (an owned-job wait, another reply wait, an inline `task` spawn, or an untimed eval handle wait). A timeout does not fulfill a request.
- Otherwise returns immediately with “Nothing to wait for”, naming any requested agent blocked on the caller.
- With no owned jobs, a service finishing returns a notice directing the caller to `proc://` for status/output; with jobs, the call returns their current snapshot/result instead.
- Results and peer messages also auto-deliver without calling `wait`. Continue useful work instead of polling.
- Queued peer messages are checked first. Already-settled but undelivered owned jobs are returned without another wait. If a peer message wins a race with job completion, that job remains eligible for normal async delivery.
- Job waits emit progress snapshots every 500 ms when an update callback is present. Job results/snapshots use `details: { op: "wait", jobs: ... }`; peer-message results use the messaging result shape.
- A running subagent's row carries its latest progress, e.g. `` - `AcpSurface` [task] — <label> — 5h7m · 90 req · $18.40 · ctx 160K/1M · stage: <stage> ``: run time, requests, cost, context fill, self-estimated completion and stage, whichever its progress record reports. Bash and eval rows, and task rows without a progress record, stay `` - `<id>` [<type>] — <label> ``. `read proc://` and `read proc://<id>` show the same progress on running task rows.

## Related surfaces
- `read proc://` lists caller-visible jobs and project services; `read proc://<id>` inspects state/output without consuming delivery.
- `write proc://<id>/kill` cancels a job or owned subagent, or stops a service; no `content` needed. Bare `proc://<id>` writes send stdin only to a service, including empty input.
- `write agent://<id>` sends a peer message; `agent://all` broadcasts to visible live peers. Bare `read history://` discovers registered agent transcripts. The final result of a subagent is delivered to its parent automatically.
- Start supervised services with `bash` `name` and optional `ready`; inspect and control them through `proc://`.
