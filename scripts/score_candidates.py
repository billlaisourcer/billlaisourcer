#!/usr/bin/env python3
"""Deterministic fit scoring for JD-intake calibration slates.

Reads an intake JSON file (see schema/intake.schema.json), computes a weighted
composite fit score for each candidate, and renders the calibration scorecard
as markdown.

Four design rules drive the arithmetic:

  1. A dimension with no supporting evidence scores null (unknown), never 0.
     Unknowns drop out of the weighted denominator and reduce `evidence_coverage`
     instead of silently dragging the composite down. Guessing a rating to fill
     a gap is the failure mode this exists to prevent.
  2. Fit and confidence are separate axes. Two engines agreeing that someone
     exists raises confidence in the read; it never raises their fit.
  3. Pipeline conflicts surface as hard flags no matter how well someone scores.
     A 92 who the client already rejected is not a calibration profile.
  4. The slate is judged as a slate. An all-on-target ten defeats the point of
     calibration, so the spread audit warns when the bands collapse.

Usage:
    python3 scripts/score_candidates.py examples/intake.example.json
    python3 scripts/score_candidates.py intake.json -o briefs/acme-scorecard.md
    python3 scripts/score_candidates.py intake.json --json      # machine-readable
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

# Weights sum to 100. Override per-req via the top-level "weights" key when a
# role genuinely re-prioritises (e.g. a cleared federal role pushes
# location_authorization far up). Document any override in the brief.
DEFAULT_WEIGHTS: dict[str, int] = {
    "must_have_coverage": 30,
    "seniority_scope": 20,
    "domain_pedigree": 15,
    "skill_depth": 15,
    "location_authorization": 10,
    "trajectory_stability": 10,
}

DIMENSION_LABELS: dict[str, str] = {
    "must_have_coverage": "Must-haves",
    "seniority_scope": "Seniority & scope",
    "domain_pedigree": "Domain pedigree",
    "skill_depth": "Skill depth",
    "location_authorization": "Location & auth",
    "trajectory_stability": "Trajectory",
}

BANDS: dict[str, str] = {
    "on_target": "On target",
    "stretch_senior": "Stretch — senior",
    "stretch_junior": "Stretch — junior",
    "adjacent": "Adjacent industry",
    "probe": "Probe / non-obvious",
}

# Pin pipeline states that must never be presented as a fresh calibration
# profile without an explicit flag.
BLOCKING_PIN_STATUS = {"rejected", "accepted"}

# Sourcing engines a slate may cite. Corroboration means two or more independently
# surfaced the same person — the strongest confidence signal there is. A
# single-engine slate is normal, not suspect.
SOURCE_LABELS = {"seekout": "SeekOut", "pin": "Pin", "supercarl": "Super Carl"}

MAX_RATING = 5

# Below this share of rubric weight, a composite is normalised over so little
# evidence that it is a guess wearing a number. Those profiles are held out of
# the ranked slate and reported separately as needing enrichment, rather than
# being allowed to outrank people we actually know something about.
EVIDENCE_FLOOR = 60


class IntakeError(Exception):
    """Raised for malformed intake files, reported without a traceback."""


def resolve_weights(doc: dict[str, Any]) -> dict[str, int]:
    weights = dict(DEFAULT_WEIGHTS)
    override = doc.get("weights") or {}
    unknown = set(override) - set(DEFAULT_WEIGHTS)
    if unknown:
        raise IntakeError(f"unknown weight keys: {sorted(unknown)}")
    weights.update(override)
    total = sum(weights.values())
    if total != 100:
        raise IntakeError(f"weights must sum to 100, got {total}")
    return weights


def score_candidate(cand: dict[str, Any], weights: dict[str, int]) -> dict[str, Any]:
    """Compute composite fit, evidence coverage, and confidence for one person."""
    scores = cand.get("scores") or {}
    earned = 0.0
    possible = 0.0
    scored_dims = 0

    for dim, weight in weights.items():
        entry = scores.get(dim) or {}
        rating = entry.get("rating")
        if rating is None:
            continue  # unknown: excluded from the denominator, not scored zero
        if not isinstance(rating, (int, float)) or not 0 <= rating <= MAX_RATING:
            raise IntakeError(
                f"{cand.get('name', '?')}: {dim} rating must be 0-{MAX_RATING} or null, got {rating!r}"
            )
        earned += (rating / MAX_RATING) * weight
        possible += weight
        scored_dims += 1

    total_weight = sum(weights.values())
    composite = round(100 * earned / possible, 1) if possible else None
    coverage = round(100 * possible / total_weight)

    sources = cand.get("sources") or {}
    active = [k for k in SOURCE_LABELS if sources.get(k)]
    corroboration = "both" if len(active) >= 2 else (active[0] if active else "none")
    source_label = " + ".join(SOURCE_LABELS[k] for k in active) or "—"

    # Confidence is about how much to trust the read, not how good the fit is.
    conf = 2 if len(active) >= 2 else 1 if active else 0
    if coverage >= 80:
        conf += 1
    elif coverage < 60:
        conf -= 1
    confidence = "High" if conf >= 3 else "Medium" if conf == 2 else "Low"

    return {
        "composite": composite,
        "evidence_coverage": coverage,
        "scored_dimensions": scored_dims,
        "corroboration": corroboration,
        "source_label": source_label,
        "confidence": confidence,
    }


def build_flags(cand: dict[str, Any], computed: dict[str, Any]) -> list[str]:
    flags: list[str] = []
    status = (cand.get("pin_status") or "not_found").lower()

    if status == "rejected":
        reason = cand.get("pin_rejection_reason") or "reason not recorded"
        flags.append(f"BLOCKED — already rejected on this req ({reason})")
    elif status == "accepted":
        stage = cand.get("pin_stage") or "active stage"
        flags.append(f"IN PIPELINE — already accepted, {stage}")
    elif status == "shortlisted":
        flags.append("Already shortlisted on this req")

    if computed["corroboration"] == "pin":
        flags.append("Pin-only — the SeekOut boolean missed them; widen titles or skills")
    elif computed["corroboration"] == "seekout":
        flags.append("SeekOut-only — absent from Pin's ranked pool")

    if computed["evidence_coverage"] < 60:
        flags.append(f"Thin evidence — only {computed['evidence_coverage']}% of the rubric is evidenced")

    return flags


def audit_spread(rows: list[dict[str, Any]]) -> list[str]:
    """A calibration slate has to disagree with itself to be useful."""
    notes: list[str] = []
    counts: dict[str, int] = {}
    for row in rows:
        counts[row.get("band") or "unbanded"] = counts.get(row.get("band") or "unbanded", 0) + 1

    on_target = counts.get("on_target", 0)
    stretch = counts.get("stretch_senior", 0) + counts.get("stretch_junior", 0)
    edge = counts.get("adjacent", 0) + counts.get("probe", 0)

    if len(rows) and on_target == len(rows):
        notes.append(
            "Every profile is on-target. The slate cannot test the seniority band or the "
            "must-haves — add stretch and adjacent profiles before sending it to the client."
        )
    if stretch == 0 and len(rows) >= 5:
        notes.append("No stretch profiles — the seniority band goes untested.")
    if edge == 0 and len(rows) >= 5:
        notes.append("No adjacent or probe profiles — nothing tests how strict the must-haves really are.")

    blocked = [r for r in rows if any(f.startswith("BLOCKED") for f in r["flags"])]
    if blocked:
        names = ", ".join(r["name"] for r in blocked)
        notes.append(f"Remove before sending — previously rejected on this req: {names}.")

    return notes


def evaluate(doc: dict[str, Any]) -> dict[str, Any]:
    weights = resolve_weights(doc)
    candidates = doc.get("candidates") or []
    if not candidates:
        raise IntakeError("no candidates in intake file")

    rows: list[dict[str, Any]] = []
    for cand in candidates:
        if not cand.get("name"):
            raise IntakeError("every candidate needs a name")
        computed = score_candidate(cand, weights)
        row = {**cand, **computed}
        row["flags"] = build_flags(cand, computed)
        rows.append(row)

    # Rank on fit; unscored candidates sort last rather than crashing the sort.
    rows.sort(key=lambda r: (r["composite"] is None, -(r["composite"] or 0)))

    # A composite built on too little evidence cannot be compared against one
    # built on a full read, so the two never share a ranking.
    ranked = [r for r in rows if r["evidence_coverage"] >= EVIDENCE_FLOOR]
    provisional = [r for r in rows if r["evidence_coverage"] < EVIDENCE_FLOOR]
    for i, row in enumerate(ranked, 1):
        row["rank"] = i
    for row in provisional:
        row["rank"] = None

    return {"req": doc.get("req") or {}, "weights": weights, "rows": rows,
            "ranked": ranked, "provisional": provisional,
            "spread_notes": audit_spread(rows)}


def fmt(value: Any, dash: str = "—") -> str:
    return dash if value in (None, "") else str(value)


def render_markdown(result: dict[str, Any]) -> str:
    req = result["req"]
    rows = result["rows"]
    weights = result["weights"]
    out: list[str] = []

    title = fmt(req.get("title"), "Untitled role")
    company = fmt(req.get("company"), "Unknown company")
    out.append(f"# Calibration scorecard — {title} @ {company}")
    out.append("")
    out.append(f"**Location:** {fmt(req.get('location'))}  ")
    out.append(f"**Seniority band:** {fmt(req.get('seniority_band'))}  ")
    out.append(f"**Slate:** {len(rows)} profiles")
    out.append("")

    must = req.get("must_haves") or []
    if must:
        out.append("**Must-haves scored against:**")
        out.extend(f"- {m}" for m in must)
        out.append("")

    def slate_row(r: dict[str, Any]) -> str:
        role = f"{fmt(r.get('title'))} @ {fmt(r.get('company'))}"
        band = BANDS.get(r.get("band"), fmt(r.get("band")))
        fit = f"**{r['composite']}**" if r["composite"] is not None else "—"
        src = r["source_label"]
        blocked = " ⛔" if any(f.startswith("BLOCKED") for f in r["flags"]) else ""
        num = r["rank"] if r["rank"] is not None else "—"
        return (f"| {num} | {r['name']}{blocked} | {role} | {band} | {fit} | "
                f"{r['evidence_coverage']}% | {r['confidence']} | {src} |")

    header = ["| # | Candidate | Current role | Band | Fit | Evid. | Conf. | Sources |",
              "|---|---|---|---|---|---|---|---|"]

    out.append("## Ranked slate")
    out.append("")
    out.extend(header)
    for r in result["ranked"]:
        out.append(slate_row(r))
    out.append("")
    out.append("_Fit is 0–100, weighted across the rubric below and normalised over the "
               "dimensions that had evidence. Evid. is the share of rubric weight actually "
               "evidenced. ⛔ marks a pipeline conflict — see the flag on the candidate._")
    out.append("")

    if result["provisional"]:
        out.append(f"## Held out — under the {EVIDENCE_FLOOR}% evidence floor")
        out.append("")
        out.extend(header)
        for r in result["provisional"]:
            out.append(slate_row(r))
        out.append("")
        out.append("_Too little of the rubric is evidenced for these composites to be compared "
                   "against the ranked slate. Enrich the profile and re-score, or drop them — "
                   "do not present the number as a read._")
        out.append("")

    out.append("## Rubric")
    out.append("")
    out.append("| Dimension | Weight |")
    out.append("|---|---|")
    for dim, w in weights.items():
        out.append(f"| {DIMENSION_LABELS.get(dim, dim)} | {w} |")
    out.append("")

    out.append("## Per-candidate reasoning")
    out.append("")
    for r in result["ranked"] + result["provisional"]:
        band = BANDS.get(r.get("band"), fmt(r.get("band")))
        heading = f"{r['rank']}. " if r["rank"] is not None else "Held out — "
        out.append(f"### {heading}{r['name']} — {fmt(r.get('composite'))}/100 · {band}")
        out.append("")
        out.append(f"{fmt(r.get('title'))} @ {fmt(r.get('company'))} · {fmt(r.get('location'))}")
        links = []
        if r.get("linkedin"):
            links.append(f"[LinkedIn]({r['linkedin']})")
        if r.get("seekout_profile_key"):
            links.append(f"`{r['seekout_profile_key']}`")
        if links:
            out.append(" · ".join(links))
        out.append("")

        if r["flags"]:
            for f in r["flags"]:
                out.append(f"> **{f}**")
            out.append("")

        out.append("| Dimension | Rating | Evidence |")
        out.append("|---|---|---|")
        for dim in weights:
            entry = (r.get("scores") or {}).get(dim) or {}
            rating = entry.get("rating")
            shown = f"{rating}/5" if rating is not None else "unknown"
            evidence = entry.get("evidence") or "_no evidence found_"
            out.append(f"| {DIMENSION_LABELS.get(dim, dim)} | {shown} | {evidence} |")
        out.append("")

        if r.get("calibration_question"):
            out.append(f"**Tests:** {r['calibration_question']}")
            out.append("")

    if result["spread_notes"]:
        out.append("## Slate audit")
        out.append("")
        out.extend(f"- {n}" for n in result["spread_notes"])
        out.append("")

    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Score a JD-intake calibration slate.")
    ap.add_argument("intake", help="path to the intake JSON file")
    ap.add_argument("-o", "--out", help="write markdown here instead of stdout")
    ap.add_argument("--json", action="store_true", help="emit computed JSON instead of markdown")
    args = ap.parse_args(argv)

    try:
        with open(args.intake, encoding="utf-8") as fh:
            doc = json.load(fh)
    except FileNotFoundError:
        print(f"error: no such intake file: {args.intake}", file=sys.stderr)
        return 1
    except json.JSONDecodeError as exc:
        print(f"error: {args.intake} is not valid JSON: {exc}", file=sys.stderr)
        return 1

    try:
        result = evaluate(doc)
    except IntakeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    payload = json.dumps(result, indent=2) if args.json else render_markdown(result)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(payload + "\n")
        print(f"wrote {args.out}")
    else:
        print(payload)
    return 0


if __name__ == "__main__":
    sys.exit(main())
