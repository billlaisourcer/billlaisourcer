---
name: jd-intake
description: >-
  Run intake on a new job description and produce a calibration slate of 10 example
  profiles with per-candidate reasoning and a scored scorecard. Use whenever a new JD
  or req arrives — a pasted job description, a job-posting URL, "new search", "new role
  to fill", "client just sent over a JD", "kicking off a req", "intake on this role",
  "who should we target", or "find me example profiles for this role". Sources from
  SeekOut, cross-references every profile against Pin for pipeline conflicts and
  retrieval blind spots, and scores the slate with the repo's deterministic rubric.
  Trigger even when the words "intake" or "calibration" are never said.
---

# JD Intake — calibration slate with cross-referenced scorecard

## What this produces

One deliverable: a **calibration brief** containing 10 example profiles, each with
explicit reasoning and a scored line on a fixed rubric.

The point of the slate is disagreement, not delivery. Ten near-identical on-target
profiles teach the client nothing. A spread — squarely on-target, a little senior, a
little junior, one adjacent — makes them say "yes like that, no not that", and that
reaction is worth more than three weeks of sourcing against a misread req.

Two things make this different from running either sourcing tool alone:

- **Two independent engines.** SeekOut is a boolean/filter search you control and can
  audit. Pin runs its own ranking from the JD text. Where they agree, confidence is
  high. Where they disagree, the disagreement is itself diagnostic.
- **Pipeline conflict detection.** Pin knows who this req already rejected, already
  contacted, or already advanced. Presenting a "new" profile the client passed on last
  month is the fastest way to lose their trust in the search. Every profile gets checked.

## Hard rules

- **Never call `accept_candidate` during intake.** It fires live outreach email to the
  candidate. Intake is calibration, not contact. Use `shortlist_candidate` to set someone
  aside — it does not contact anyone. If the recruiter wants outreach, that is a separate,
  explicit decision they make after seeing the brief.
- **Never invent a person, employer, tenure, or link.** A profile with three honest facts
  and four "unknown"s is useful. A fabricated one poisons the calibration and the search.
  The rubric is built to absorb unknowns — use them.
- **Never rate a dimension you have no evidence for.** Set `rating: null` and say why in
  the evidence field. The scorer excludes unknowns from the denominator and reports
  evidence coverage, so honesty costs nothing and guessing corrupts the ranking.
- **Pass `user_intent` and `user_intent_category` on every SeekOut call that accepts
  them** — `set_query`, `verify_search`, `get_state`, `count_results`, `create_workspace`,
  `add_to_workspace`, `export_profiles`, `get_emails`, `get_phones`. `user_intent` is the
  recruiter's message verbatim; the category for intake is `hire`.
- **Don't narrate the tool run.** Gather quietly, surface decision points and blockers
  only. The brief is the deliverable, not a log of every search.

## Workflow

### 0. Get the JD, and check whether the req already exists

- Job-posting URL → `mcp__Pin__scrape_job_description`.
- Pasted text → use it directly.
- Named an existing req → `mcp__Pin__list_jobs` (filter by title), then
  `mcp__Pin__read_job_memory` on the match. Prior memory carries the recruiter's accept
  and reject patterns from earlier sessions; it changes how you weight the rubric and
  which profiles are worth including. Read it before searching, not after.

Always run `list_jobs` even for a JD that looks new — a near-duplicate req usually means
an existing candidate pool and a memory worth inheriting.

If the JD gives no location or remote policy, ask once before searching. Geography anchors
the entire talent pool and everything downstream depends on it. That is the only question
worth blocking on; anything else can go in "open questions for the client".

### 1. Dissect the JD

Read SeekOut's own intake playbook first so the boolean follows its current conventions
rather than your memory of them:

```
mcp__Seekout__read_resource(uri="skill://intake/SKILL.md")
mcp__Seekout__read_resource(uri="skill://talent-search/references/boolean-patterns.md")
```

Extract, and write these down — they become the scorer's `req` block:

- **Real title and level**, separate from the inflated title on the posting.
- **Must-haves** — the 3–6 things a candidate genuinely cannot lack. JDs over-list
  routinely; the wish-list is not the must-have list. These are what
  `must_have_coverage` scores against, so getting this wrong miscalibrates every profile.
- **Nice-to-haves and deal-breakers.**
- **Seniority band** — years plus scope of ownership, not just a title word.
- **Location / remote policy.**
- **Target companies** — where this talent actually sits (step 2 fills this out).
- **Open questions** — at most two genuine ambiguities worth raising with the client.
  Don't manufacture uncertainty where the JD is clear.

### 2. Engine A — SeekOut

Follow `skill://talent-search/SKILL.md`. The shape that matters:

1. `set_query` with `cur_title:("Title A" OR "Title B" OR ...)` plus free-text skill
   keywords. Include 3–5 title variants including one level up and one down — the
   stretch bands depend on them. Never use `skills:()` syntax; it drops up to half the
   pool. `AND` between must-have skill families, `OR` only inside a family.
2. `add_filter` batched in one call — locations, target companies, exclusions.
3. `count_results` to size the pool. Under 20 is too narrow to calibrate against; over
   5000 means the boolean isn't saying anything. Fix it before searching.
4. `verify_search` — the pre-render gate. Its `sample_candidates` are evidence for the
   gate, **not** your slate. Never present them as the result.
5. `search_people` on a `show` decision. Pull ~15–20 so there's room to select a spread
   of 10 rather than taking whatever the top 10 happens to be.
6. `get_profile` on your selected keys for the detail the rubric needs — tenure, scope,
   skills. You cannot honestly score `seniority_scope` or `trajectory_stability` off a
   search snippet.
7. `get_search_links` to capture a shareable link for the brief, so the client can see
   the actual query behind the slate.

Check `match_signals` on every result. Drop anything with `function_mismatch`, and treat
`location_match: false` as a location dimension failure rather than something to ignore.

### 3. Engine B — Pin

If the req already exists in Pin, use it. Otherwise `mcp__Pin__create_job` with the title,
company name, company website, and full JD text, then `mcp__Pin__get_candidates` with
`take: 10` once. The tool waits for the search rather than returning early — call it once,
don't poll.

Pin's ranked list is the second opinion. You are not merging it into SeekOut's list; you
are comparing two independent reads of the same JD.

### 4. Cross-reference

The mechanics are in `references/cross-reference.md`. In short:

For every SeekOut profile, call `mcp__Pin__get_candidate(job_id, name="Full Name")` and
record what comes back. Then diff the two engines' sets to get one of four states per
person — `both`, `seekout_only`, `pin_only`, or a pipeline conflict — and record Pin's
status. `both` is your highest-confidence group. Pipeline conflicts come out of the slate.

**Use `pin_only` as a query-repair signal.** If several of Pin's top 10 never appeared in
your SeekOut results, your boolean is too narrow. Look at their actual titles, widen
`cur_title` to cover them, and re-run step 2 before building the slate. This is the single
highest-value part of the cross-reference and it is easy to skip.

### 5. Select the 10 and score them

Pick for spread, not for the top 10 by rank:

| Band | Count | What it tests |
|---|---|---|
| `on_target` | 4–5 | Is this the shape the client actually means? |
| `stretch_senior` | 1–2 | Will they stretch on level and comp? |
| `stretch_junior` | 1–2 | Is the years/scope floor real or aspirational? |
| `adjacent` | 1–2 | How strict are the domain must-haves? |
| `probe` | 0–1 | A non-obvious read worth a reaction. |

Write the intake JSON per `schema/intake.schema.json` — rate each of the six rubric
dimensions with the specific profile fact behind it, `null` where there's no evidence.
The rating rules are in `references/rubric.md`; follow them rather than improvising a
scale. Give each profile a `calibration_question`: the one thing showing them tests.

Then run the scorer:

```bash
python3 scripts/score_candidates.py briefs/<req-slug>.json -o briefs/<req-slug>-scorecard.md
```

Read what it gives back. A held-out profile means you need to enrich it with `get_profile`
or drop it. A slate-audit warning about band collapse means reselect — don't ship a slate
that can't test anything.

### 6. Deliver

Post the brief in chat using `references/brief-template.md`, with the scorecard table
inline. Commit the intake JSON and the generated scorecard under `briefs/` so the req has
a record and the next session can pick it up.

Then offer the real next steps, and let the recruiter choose:

- Save the calibration read to the req — `mcp__Pin__update_job_memory` with what the
  rubric weighting and band choices imply, so the next session inherits it.
- Set profiles aside — `mcp__Pin__shortlist_candidate` (no contact).
- Save the SeekOut search — `create_workspace` / `add_to_workspace`.
- Start outreach — only on an explicit yes, and only then `accept_candidate`.

## Files

- `references/rubric.md` — the six dimensions, what each rating means, how to handle unknowns.
- `references/cross-reference.md` — the two-engine diff and the query-repair loop.
- `references/brief-template.md` — the delivered brief's structure.
- `schema/intake.schema.json` — the intake file format.
- `scripts/score_candidates.py` — the deterministic scorer.
