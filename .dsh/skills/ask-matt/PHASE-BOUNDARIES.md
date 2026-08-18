# Phase boundaries

Make a context decision only after the current phase has an observable result.

1. Continue in the current Session when the next phase needs the conversation as primary context and the remaining context capacity is adequate.
2. Start a fresh Session when the accepted spec or Work Item is self-contained and the exploratory conversation is no longer needed.
3. Use `handoff` when the work moves to another harness, person, repository, or working directory. The handoff is a portable secondary source and links to committed primary sources.
4. Use a `subagent` for a bounded task that can run without steering and return a result to this Session.
5. Let the configured context policy compact the Session when relevant context must stay in the same Session but exceeds the model route's safe working capacity.

Do not use a handoff merely to shorten the current conversation. Do not delegate an unsettled product decision to a subagent.
