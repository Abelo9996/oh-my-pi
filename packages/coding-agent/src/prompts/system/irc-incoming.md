<irc>
Incoming IRC message `{{id}}` from agent `{{from}}`{{#if replyTo}} (final reply to {{replyTo}}){{/if}}:

{{message}}

{{#if interrupting}}Sent while waiting/working. Active interruptible wait stopped early for immediate reading.{{/if}}

{{#unless replyTo}}If response expected, send the final reply via `write` (`path: "agent://{{from}}?replyTo={{id}}"`, `content: "…"`). For interim acknowledgements/progress use `agent://{{from}}` without `replyTo`; those do not fulfill this request.{{#if relayOnStop}} Otherwise what you `yield` or say last this turn is delivered to `{{from}}` as its correlated reply when you stop.{{else}} May finish current step first. No one replies on your behalf.{{/if}}{{/unless}}
</irc>
