Wait only when blocked with nothing else to do.
Blocks on background jobs/services you started, or on the reply to a message you sent this run; returns on the first result, a message sent to you, or a steering interrupt; a safety cap returns a still-running snapshot.
Nothing you started running and no reply owed? Returns at once.
A peer's interim acknowledgement or uncorrelated message does not fulfill your request; its final reply must carry `?replyTo=<message-id>`. Sending progress on a request you owe creates no reverse reply obligation. Idle/wake transitions do not cancel a request. Each wait remains capped at 30 minutes.
Results and messages auto-deliver. NEVER poll while work remains.
