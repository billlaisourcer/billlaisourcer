import Anthropic, {
  APIConnectionError,
  APIError,
  AuthenticationError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import { extractJson } from "../lib/intake-schema.js";
import {
  EXPECTED_FIELDS,
  MOTIONS,
  MUST_HAVE_VERDICTS,
  SOURCES,
  SubmissionSchema,
  type Field,
  type Submission,
} from "../lib/submission-schema.js";
import { newRunId, saveSubmission, storageConfigured } from "../lib/history.js";
import { readResumeFile, type Resume } from "../lib/resume.js";

/**
 * POST /api/submission
 *
 * Body: { notes, resume_text?, resume_pdf?, client?, role?, jd?, must_haves? }
 * Auth: none, matching /api/intake. See the note in that handler.
 *
 * Turns screening-call notes plus a resume into a structured recruiter
 * submission. One model call, no tool loop — the resume goes to Claude as a
 * PDF document block rather than through a parsing library.
 */

/** One call with a document attached. Generous, but far short of a tool loop. */
export const maxDuration = 180;

/**
 * Opus 5, unlike the intake endpoint's Sonnet 5. This is one short call rather
 * than a four-search tool loop, so it costs cents either way, and the job it
 * does — deciding what the notes did NOT establish and refusing to fill the
 * gap — is exactly where a stronger model earns its keep. Overridable without
 * a deploy, the same way INTAKE_MODEL is: set SUBMISSION_MODEL to
 * claude-sonnet-5 to halve the per-run cost. The cache is model-scoped, so
 * changing it starts the cache cold once.
 */
const MODEL = process.env.SUBMISSION_MODEL || "claude-opus-5";

/** Long enough that neither side of the input can be pure noise. */
const MIN_INPUT_CHARS = 40;

const SOURCE_LIST = SOURCES.join(" | ");

const SYSTEM = `You write recruiter submissions. You take a recruiter's screening-call notes and
a candidate's resume, and you produce the structured writeup a recruiter sends to their
client about one candidate.

## The rule that matters more than the rest

**Never invent a fact about a person.** A submission that carries a compensation number
the candidate never said, or a reason for leaving you reasoned your way to, does not just
contain a mistake — it destroys the recruiter's credibility with their client the first
time it is checked against the candidate. Every field you cannot establish from the notes
or the resume gets \`"value": null\`. That is the correct, useful answer: the page turns
those nulls into a list of what still needs asking. A null costs the recruiter one
follow-up question. A fabrication costs them the client.

Specifically:

- If the call did not cover compensation, \`compensation.expectation.value\` is null. Do
  not derive it from market rates, from their title, or from the seniority of the role.
- If they never said why they are leaving, \`reason_for_leaving.value\` is null. Do not
  build one out of tenure length or a gap on the resume.
- Do not upgrade a hedge into a commitment. "Probably around 180" is "Probably around
  180", not "180".

## Provenance

Every field carries \`source\`, one of: ${SOURCE_LIST}.

- \`call\` — the candidate said it on the call.
- \`resume\` — the resume shows it.
- \`both\` — both agree. This is the strongest signal you can report.
- \`inferred\` — you read it between the lines. Legitimate, but the recruiter must see
  the label before repeating it to a client as fact, so use it honestly and often rather
  than dressing an inference up as something stated.

Set \`quote\` to the actual words behind the field — from the notes or the resume —
whenever there are any. A recruiter checking your work should not have to hunt.

**Where the notes and the resume disagree, say so** rather than silently picking one.
Put it in the field's value ("Resume says 2019-2024; on the call said he left in
early 2023") and, when it matters, in client_fit.concerns.

## What the client is reading for

- **Reason for leaving** — in the candidate's own framing, not your paraphrase of it.
- **Background** — years, the domains they have actually worked in, and whether their
  experience is b2b, b2c, both, or unclear. Get the motion right: selling a $200k annual
  contract to a procurement committee and selling a $9/month subscription are different
  jobs, and a client screens hard on it. Put the reasoning in motion_evidence.
- **AI enablement** — rate 0-5 on evidence of *doing*, not of claiming. Shipping an
  AI-backed feature, or rebuilding a workflow around a model, is real evidence. Listing
  "ChatGPT" under skills is not. Rate null when nothing in either source speaks to it,
  and say in the summary what you looked for.
- **Location, work preference, authorization** — three different questions. Someone can
  be in Austin, want fully remote, and need sponsorship.
- **Compensation** — what they earn now if they said, what they want, and how firm it is.
- **Availability** — notice period, and what else is in play. Competing processes set the
  client's clock, and a recruiter who omits them looks careless when an offer lands.
- **Fit and concerns** — alignment with the client's mission, why this client
  specifically, and the honest watch-outs. A submission with no concerns has not been
  thought about; find the real ones, and leave concerns empty only when there genuinely
  are none.
- **recruiter_summary** — three to five sentences, the paragraph the client reads first.
  Lead with why this person is worth their time. It must be supportable entirely by
  fields above it; do not introduce a claim here that appears nowhere else.

## Must-haves

When the request carries the role's stated must-haves, assess each one and return
must_have_assessment with a verdict of ${MUST_HAVE_VERDICTS.join(", ")}. \`unknown\`
means neither source speaks to it — use it rather than guessing at \`met\`. Omit the
field entirely when no must-haves were supplied.

## Output

Reply with ONE fenced json block and nothing else outside it. No preamble.

\`\`\`json
{
  "candidate": { "name": "...", "current_title": "...", "current_company": "...", "linkedin": null },
  "location":            { "value": "Austin, TX", "source": "call", "quote": "based in Austin" },
  "work_preference":     { "value": null, "source": null, "quote": null },
  "work_authorization":  { "value": null, "source": null, "quote": null },
  "background": {
    "years_experience": { "value": "11 years", "source": "resume", "quote": "..." },
    "domains": ["fintech", "developer tools"],
    "motion": "${MOTIONS[0]}",
    "motion_evidence": "why you concluded that",
    "company_stages": { "value": "Series B through IPO", "source": "resume", "quote": "..." },
    "highlights": ["concrete, checkable accomplishments"]
  },
  "reason_for_leaving": { "value": "...", "source": "call", "quote": "their own words" },
  "looking_for":        { "value": "...", "source": "call", "quote": "..." },
  "ai_enablement": { "rating": 3, "summary": "...", "evidence": ["..."] },
  "compensation": {
    "current":     { "value": null, "source": null, "quote": null },
    "expectation": { "value": "$210k base", "source": "call", "quote": "..." },
    "notes":       { "value": "...", "source": "call", "quote": "..." }
  },
  "availability": {
    "notice":          { "value": "4 weeks", "source": "call", "quote": "..." },
    "other_processes": { "value": null, "source": null, "quote": null }
  },
  "client_fit": {
    "mission_alignment": { "value": "...", "source": "call", "quote": "..." },
    "motivation":        { "value": "...", "source": "call", "quote": "..." },
    "concerns": ["honest watch-outs"]
  },
  "must_have_assessment": [
    { "requirement": "...", "verdict": "met", "evidence": "..." }
  ],
  "recruiter_summary": "..."
}
\`\`\`

Every field in that shape must be present. Use null for what you could not establish —
never the empty string, and never a plausible substitute.`;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Read a Field at a dotted path, for the coverage count. */
function fieldAt(sub: Submission, path: string): Field | undefined {
  let node: unknown = sub;
  for (const part of path.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node as Field | undefined;
}

/**
 * How many expected fields nobody established.
 *
 * Counted in code rather than asked of the model, for the same reason the slate
 * scorer computes composites in code: a number the model reports about its own
 * output can disagree with the output.
 */
export function countGaps(sub: Submission): number {
  return EXPECTED_FIELDS.filter((f) => (fieldAt(sub, f.path)?.value ?? null) === null).length;
}

export async function POST(request: Request): Promise<Response> {
  const startedAt = Date.now();

  if (!process.env.ANTHROPIC_API_KEY) {
    return json({ error: "Server is not configured: ANTHROPIC_API_KEY is unset." }, 503);
  }

  let body: {
    notes?: unknown;
    resume_text?: unknown;
    resume_file?: unknown;
    client?: unknown;
    role?: unknown;
    jd?: unknown;
    must_haves?: unknown;
    run_id?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be JSON." }, 400);
  }

  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const notes = str(body.notes);
  const pastedResume = str(body.resume_text);
  const client = str(body.client);
  const role = str(body.role);
  const jd = str(body.jd);
  const runId = str(body.run_id) || null;

  const mustHaves = Array.isArray(body.must_haves)
    ? body.must_haves
        .filter((x): x is string => typeof x === "string")
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 8)
    : [];

  // A dropped file wins over pasted text — someone who just dropped a resume
  // meant that one.
  let resume: Resume | null = null;
  const file = body.resume_file;
  if (file && typeof file === "object") {
    const f = file as Record<string, unknown>;
    const read = await readResumeFile({
      name: str(f.name),
      type: str(f.type),
      data: typeof f.data === "string" ? f.data : "",
    });
    if (!read.ok) return json({ error: read.error }, read.status);
    resume = read.resume;
  } else if (pastedResume) {
    resume = { kind: "text", text: pastedResume, filename: "" };
  }

  if (notes.length < MIN_INPUT_CHARS && !resume) {
    return json(
      {
        error:
          "Give the call notes, a resume, or both. With neither there is nothing to " +
          "build a submission from.",
      },
      400,
    );
  }

  const parts: string[] = [];
  if (client || role) {
    parts.push(
      `Submitting to: ${client || "an unnamed client"}` +
        (role ? ` — for the ${role} role.` : "."),
    );
  }

  parts.push(
    notes
      ? `\n\n--- SCREENING CALL NOTES ---\n${notes}`
      : `\n\n--- SCREENING CALL NOTES ---\n(None supplied. Every field that only a ` +
          `conversation could establish must therefore be null — do not reach for the ` +
          `resume to fill one in.)`,
  );

  if (resume?.kind === "text") {
    parts.push(
      `\n\n--- RESUME${resume.filename ? ` (${resume.filename})` : ""} ---\n${resume.text}`,
    );
  } else if (resume?.kind === "pdf") {
    parts.push(`\n\n--- RESUME ---\nAttached as a PDF document (${resume.filename}).`);
  } else {
    parts.push(
      `\n\n--- RESUME ---\n(None supplied. Work from the call notes alone and leave ` +
        `anything only a resume would show as null.)`,
    );
  }

  if (jd) parts.push(`\n\n--- THE ROLE ---\n${jd}`);
  if (mustHaves.length) {
    parts.push(
      `\n\n--- STATED MUST-HAVES ---\nAssess each of these and return ` +
        `must_have_assessment:\n${mustHaves.map((m) => `  - ${m}`).join("\n")}`,
    );
  }

  parts.push(
    `\n\nWrite the submission. Null out everything neither source establishes — the ` +
      `recruiter needs to see the gaps, not have them papered over.`,
  );

  // The document block goes before the text, per the PDF input contract.
  const content: Anthropic.ContentBlockParam[] = [];
  if (resume?.kind === "pdf") {
    content.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: resume.base64 },
    });
  }
  content.push({ type: "text", text: parts.join("") });

  const anthropic = new Anthropic();

  try {
    // Streamed because a resume PDF plus notes can run long enough to brush the
    // SDK's HTTP timeout on a non-streaming call.
    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: "medium" },
      // One breakpoint at the end of the static prefix. The system prompt is
      // long and identical on every submission, so this is the whole win; the
      // notes and resume that follow are unique per run and would only pay the
      // write premium.
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content }],
    });

    const message = await stream.finalMessage();

    const u = message.usage;
    const usage = {
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    };
    // Per-MTok rates, so the figure stays honest if SUBMISSION_MODEL changes.
    // Cache reads bill at ~0.1x input, writes at ~1.25x.
    const RATES: Record<string, { in: number; out: number }> = {
      "claude-opus-5": { in: 5, out: 25 },
      "claude-sonnet-5": { in: 2, out: 10 },
    };
    const rate = RATES[MODEL] ?? RATES["claude-opus-5"]!;
    const cost =
      (usage.input_tokens * rate.in +
        usage.cache_read_input_tokens * rate.in * 0.1 +
        usage.cache_creation_input_tokens * rate.in * 1.25 +
        usage.output_tokens * rate.out) /
      1_000_000;
    console.log(
      "submission usage",
      JSON.stringify({ model: MODEL, ...usage, cost_usd: cost }),
    );

    if (message.stop_reason === "refusal") {
      return json(
        { error: "The model declined this request.", stop_details: message.stop_details },
        422,
      );
    }

    const text = message.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    if (!text.trim()) {
      return json(
        { error: "The model returned no text — likely ran out of tokens mid-writeup." },
        502,
      );
    }

    let parsed: unknown;
    try {
      parsed = extractJson(text);
    } catch (err) {
      return json(
        {
          error: "Could not read a submission out of the model response.",
          detail: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }

    const result = SubmissionSchema.safeParse(parsed);
    if (!result.success) {
      return json(
        {
          error: "The generated submission did not match the schema.",
          issues: result.error.issues.slice(0, 10),
          model_said: text.slice(0, 800),
        },
        502,
      );
    }

    const meta = {
      model: MODEL,
      stop_reason: message.stop_reason,
      usage,
      cost_usd: Math.round(cost * 10000) / 10000,
      elapsed_ms: Date.now() - startedAt,
      gaps: countGaps(result.data),
      resume: (resume?.kind ?? "none") as "pdf" | "text" | "none",
    };

    // Same contract as the sourcing endpoint: recording the work must never be
    // able to fail the work.
    const id = newRunId();
    const saved = await saveSubmission({
      id,
      created_at: new Date(startedAt).toISOString(),
      operator: null,
      context: {
        client,
        role,
        notes,
        // Never store the uploaded bytes — they would dwarf the record and the
        // store has no need of them. Extracted text is small and worth keeping;
        // a PDF leaves only its filename, and the submission itself is what
        // anyone comes back for.
        resume_text: resume?.kind === "text" ? resume.text : "",
        resume_filename: resume?.filename ?? "",
        jd,
        must_haves: mustHaves,
        run_id: runId,
      },
      submission: result.data,
      meta,
    });

    return json(
      {
        submission: result.data,
        meta: {
          ...meta,
          submission_id: saved ? id : null,
          saved,
          history_configured: storageConfigured(),
        },
      },
      200,
    );
  } catch (err) {
    if (err instanceof RateLimitError) {
      return json({ error: "Rate limited by the Claude API. Try again shortly." }, 429);
    }
    if (err instanceof AuthenticationError) {
      return json({ error: "Claude API rejected the key.", detail: err.message }, 502);
    }
    if (err instanceof APIConnectionError) {
      return json({ error: "Could not reach the Claude API." }, 504);
    }
    if (err instanceof APIError) {
      return json({ error: `Claude API error ${err.status}.`, detail: err.message }, 502);
    }
    return json(
      { error: "Unexpected failure.", detail: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}
