[Wait interrupted by message]
<irc from="parent" agent="{{from}}">
Message `{{id}}`{{#if replyTo}} (final reply to {{replyTo}}){{/if}}:

{{message}}

{{#unless replyTo}}If replying via `write`, send the final reply to `agent://{{from}}?replyTo={{id}}`. Interim acknowledgements/progress use `agent://{{from}}` without `replyTo` and neither fulfill this request nor create a reverse reply obligation. Your owned task result also answers your parent.{{/unless}}
</irc>
