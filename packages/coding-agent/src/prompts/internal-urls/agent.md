`agent://<id>`: latest completed output (status + progress while unpublished); nested IDs dotted, `/key/index` JSON path; write = message, `agent://all` broadcast only.
Final replies: write `agent://<id>?replyTo=<incoming-message-id>` to fulfill that request. Interim acknowledgements/progress omit `replyTo` and do not fulfill it; a later `wait` may still block for up to 30 minutes.
