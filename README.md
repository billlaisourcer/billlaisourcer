# Intake recruiting tool

Turns a new job description into a **calibration slate**: 10 example profiles, each with
explicit reasoning and a score on a fixed rubric, sourced from SeekOut and cross-referenced
against Pin.

The slate is a conversation tool, not a shortlist. Showing a client ten concrete people
early surfaces disagreements about seniority, must-haves, and target companies *before*
weeks of sourcing get spent against a misread req.

## How it works

```
new JD ──► dissect ──┬──► SeekOut  (boolean + filters you control, auditable)
                     │
                     └──► Pin      (independent ranking from the JD text)
                              │
                     cross-reference
                              │
              ┌───────────────┼───────────────┐
       corroboration   blind spots     pipeline conflicts
       (both engines)  (Pin-only →     (already rejected /
                        widen boolean)  already contacted)
                              │
                        score + brief
```

Neither engine alone gives you this. SeekOut is auditable but only as good as the boolean
you wrote. Pin ranks independently and knows the req's history. Diffing them catches the
query being too narrow, and catches candidates the client already passed on — the fastest
way to lose their confidence in a search.

## Deploying the web UI

`web/index.html` is a complete, self-contained HTML document — no build step, no
dependencies, no server. Open it locally by double-clicking, or host it anywhere.

**Vercel:** import this repo at vercel.com/new. The root `vercel.json` sets
`outputDirectory: web`, so a zero-config import works. If Vercel serves the repo root
instead and you get a 404, set **Root Directory** to `web` in Project Settings.

**CLI:** `cd web && npx vercel --prod`.

Deploys carry `X-Robots-Tag: noindex` and a `robots.txt` — this is an internal tool and
does not belong in search results. Nothing pasted into the page is ever transmitted; it
stays in the viewer's own browser via `localStorage`.

## Web UI

A browser version of the scorer is published as an artifact — paste an intake JSON, get the
scored slate, copy the markdown back out. No terminal, no Python, shareable by link:

**https://claude.ai/code/artifact/893b1886-6a8f-4427-8a10-2f4dc0766112**

The source is `web/index.html`, a single self-contained file. Its scoring core is a port of
`scripts/score_candidates.py` and the two are verified to produce byte-identical markdown —
if you change the rubric in one, change it in the other and re-run the parity check:

```bash
python3 scripts/score_candidates.py examples/intake.example.json > /tmp/py.md
# extract the JS core and run it over the same fixture, then diff against /tmp/py.md
```

## Usage

The skill triggers on its own whenever a new JD arrives — pasted text, a posting URL, or
"client just sent this over". No command needed. To run it explicitly:

```
/jd-intake
```

Score a slate directly:

```bash
python3 scripts/score_candidates.py briefs/<req>.json -o briefs/<req>-scorecard.md
python3 scripts/score_candidates.py briefs/<req>.json --json   # machine-readable
```

Try it against the bundled fixture:

```bash
python3 scripts/score_candidates.py examples/intake.example.json
```

## The rubric

| Dimension | Weight |
|---|---|
| Must-have coverage | 30 |
| Seniority & scope | 20 |
| Domain pedigree | 15 |
| Skill depth | 15 |
| Location & authorization | 10 |
| Trajectory & stability | 10 |

Three properties keep the numbers honest:

- **Unknown is not zero.** A dimension with no evidence scores `null` and drops out of the
  weighted denominator, rather than quietly punishing candidates with sparse profiles.
- **There's an evidence floor.** Below 60% rubric coverage a composite is normalised over
  too little to be comparable, so those profiles are held out of the ranking instead of
  competing with fully-read ones.
- **Fit and confidence are separate axes.** Both engines agreeing raises confidence in the
  read. It never raises the fit score.

Per-req reweighting is supported and must be stated in the brief. Details in
`.claude/skills/jd-intake/references/rubric.md`.

## Safety

`accept_candidate` in Pin **sends live outreach email to the candidate**. Intake never
calls it. Setting someone aside uses `shortlist_candidate`, which contacts nobody.
Outreach is a separate decision the recruiter makes after seeing the brief.

## Layout

```
.claude/skills/jd-intake/
  SKILL.md                       the workflow
  references/rubric.md           dimensions, rating scale, the unknown rule
  references/cross-reference.md  the two-engine diff and query-repair loop
  references/brief-template.md   what gets delivered
scripts/score_candidates.py      deterministic scorer and markdown renderer
web/index.html                   browser UI; scoring core ported from the script
schema/intake.schema.json        intake file format
examples/intake.example.json     illustrative fixture (invented people)
briefs/                          committed slates and scorecards, one per req
```
