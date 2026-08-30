# The rubric

Six dimensions, weights summing to 100. The scorer normalises over whichever dimensions
actually have evidence, so an unknown costs coverage rather than points.

| Dimension | Weight | Question it answers |
|---|---|---|
| `must_have_coverage` | 30 | How many of the req's must-haves does the profile actually evidence? |
| `seniority_scope` | 20 | Does their level and scope of ownership sit in the stated band? |
| `domain_pedigree` | 15 | Have they done this in a comparable company, industry, and stage? |
| `skill_depth` | 15 | Depth on the core skill, not just presence of the keyword. |
| `location_authorization` | 10 | Geography and work eligibility against the role's policy. |
| `trajectory_stability` | 10 | Tenure pattern and direction — is scope growing? |

## Rating scale

Every rating is 0–5 and every rating needs a specific profile fact in `evidence`.

| Rating | Meaning |
|---|---|
| 5 | Clearly exceeds. The evidence is explicit and strong. |
| 4 | Meets it, with the evidence directly stated. |
| 3 | Partial. Meets some of it, or meets it at smaller scale than the req implies. |
| 2 | Weak. Adjacent experience that a hiring manager would argue about. |
| 1 | Barely. Present in name only. |
| 0 | Explicitly fails. Evidence shows the opposite. |
| `null` | **Unknown.** No evidence either way. |

## The unknown rule

`0` and `null` are not the same thing and confusing them is the most common way to
corrupt a slate.

- `0` means *the evidence says they fail this*. A candidate in Berlin for a role requiring
  onsite in Austin with no relocation scores 0 on location.
- `null` means *there is no evidence*. A profile that doesn't state location scores `null`.

Scoring an unknown as 0 buries good candidates whose profiles happen to be sparse.
Guessing a 4 to fill the gap invents a fact. Both are worse than admitting the gap: the
scorer excludes `null` from the denominator and reports evidence coverage instead, and
anything under 60% coverage is held out of the ranking rather than allowed to compete
with a full read.

If a dimension keeps coming back `null` across the slate, that's a signal to call
`mcp__Seekout__get_profile` on those keys — search snippets don't carry enough for
`seniority_scope` or `trajectory_stability`.

## Fit is not confidence

The composite says how well they match. Confidence says how much to trust that number.
They move independently, and the brief must not blur them.

Confidence rises when both engines surfaced the person (two independent retrieval methods
agreeing is real signal about the read) and when evidence coverage is high. It never rises
because someone scored well. A 92 on 60% coverage from one engine is a hypothesis; a 78 on
100% coverage from both is a finding. Say so in the brief.

## Reweighting

Override weights per req in the intake file's `weights` block when the role genuinely
re-prioritises — a cleared federal role pushes `location_authorization` far up, a founding
engineer role pushes `trajectory_stability` down because everyone worth hiring has taken
risks. Weights must sum to 100 and the scorer rejects the file if they don't.

Always state the override and the reason in the brief. A silently reweighted scorecard is
not auditable, and the client is entitled to know what the number was built from.
