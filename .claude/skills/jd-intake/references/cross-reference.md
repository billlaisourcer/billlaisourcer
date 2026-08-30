# Cross-referencing SeekOut against Pin

Two engines read the same JD by different methods. SeekOut runs the boolean and filters
you wrote, so it is auditable and you own its blind spots. Pin ranks from the JD text
itself and additionally knows the req's history — who was contacted, passed on, advanced.

Running both and diffing them buys three things you cannot get from either alone:
corroboration, retrieval-blind-spot detection, and pipeline conflict detection.

## Per-candidate check

For each profile in the SeekOut slate:

```
mcp__Pin__get_candidate(job_id="<req uuid>", name="Full Name")
```

Name matching is partial and case-insensitive, so check `totalCount` — a common name can
match several people. Narrow with the fuller name before concluding anything, and confirm
against current title and company before treating a match as the same person. A false
match is worse than no match: it attaches someone else's rejection to your candidate.

Map the response into the intake file:

| Pin response | `sources.pin` | `pin_status` |
|---|---|---|
| no match | `false` | `not_found` |
| match, no status field | `true` | `unreviewed` |
| match with `shortlistedAt` | `true` | `shortlisted` |
| match with `stage` | `true` | `accepted` |
| match with `rejectionReason` | `true` | `rejected` (record the reason) |

Prefer `mcp__Pin__get_pipeline_summary` first for a one-shot read of where the req stands,
and `mcp__Pin__list_candidates(status="rejected")` to pull the whole reject list in one
call rather than probing name by name when the pool is large.

## The four states

**`both` — SeekOut and Pin.** Two independent methods surfaced the same person. This is
the highest-confidence group and where the on-target band should mostly come from.

**`seekout_only`.** Your boolean found them, Pin's ranking didn't. Usually fine — Pin
returns a top-10, so absence often just means rank 11+. Not a defect on its own.

**`pin_only`.** Pin ranked them; your boolean missed them entirely. This is the useful
one. One or two is noise. Three or more out of Pin's top 10 means the boolean is too
narrow, and the fix is mechanical:

1. Read their actual current titles from the Pin results.
2. Find the pattern — usually a title variant you didn't think of ("Infrastructure
   Engineer, ML" when you searched "ML Infrastructure Engineer"), a company you didn't
   target, or a skill family you over-constrained with `AND`.
3. Widen `cur_title` or relax the offending clause, re-run `count_results` and
   `verify_search`, and rebuild the slate.

Do this **before** scoring. A slate built on a boolean that demonstrably misses people is
calibrating the client on an artefact of your query rather than on the market.

**Pipeline conflict — `rejected` or `accepted`.** Take them out of the slate. The scorer
flags them with `BLOCKED` or `IN PIPELINE` and the slate audit names them, but the flag is
a safety net, not permission to ship them. Showing a client someone they already passed on
reads as not having done the homework, and it is the most expensive kind of unforced error
at intake.

A rejection reason is also calibration data in its own right. Several
`TOO_MUCH_EXPERIENCE` rejections on the req mean the stated seniority band is wrong, and
that belongs in the brief's open questions.

## Feeding the loop back

Once the recruiter reacts to the slate, write what you learned to
`mcp__Pin__update_job_memory` — which bands they liked, which must-haves turned out to be
soft, any reweighting and why. The next session on this req reads that memory in step 0
and starts calibrated instead of starting over.
