# Out-of-scope records

`.out-of-scope/<concept>.md` stores a durable, concept-level rejection of an enhancement. It is not used for bugs, implemented behavior, or temporary deferrals.

Each record names the concept, the current rejection and durable rationale, relevant architectural constraints, and a `## Prior requests` list of Issue links. Reuse an existing concept record instead of creating one file per Issue.

During triage, compare the incoming request by meaning rather than keyword. The maintainer may confirm the prior decision, reconsider and remove or update the record, or decide that the requests are distinct. A confirmed rejection adds the current Issue link, posts the required AI disclaimer and rationale, and closes the Issue through the configured triage role.
