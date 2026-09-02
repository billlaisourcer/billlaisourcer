import Anthropic, {
  APIConnectionError,
  APIError,
  AuthenticationError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import { IntakeSchema, extractJson } from "../lib/intake-schema.js";
import {
  BAND_TARGETS,
  DEFAULT_WEIGHTS,
  DIMENSIONS,
  EVIDENCE_FLOOR,
  SLATE_SIZE,
} from "../lib/rubric.js";

/**
 * POST /api/intake
 *
 * Body: { jd: string, location?: string, notes?: string }
 * Auth: none — deliberately open, see the note in the handler.
 *
 * Turns a job description into a scored calibration slate by giving Claude a
 * live connection to Super Carl's MCP server and asking it to source, band and
 * score the result against the repo's rubric.
 */

/** Sourcing runs a live tool loop; it needs far longer than the 10s default. */
export const maxDuration = 300;

const MCP_SERVER_URL = "https://api.supercarl.ai/mcp";
const MCP_NAME = "supercarl";

const RUBRIC_TABLE = DIMENSIONS.map(
  (d) => `  - ${d} (weight ${DEFAULT_WEIGHTS[d]})`,
).join("\n");

const BAND_TABLE = Object.entries(BAND_TARGETS)
  .map(([band, guidance]) => `  - ${band}: ${guidance}`)
  .join("\n");

const SYSTEM = `You run recruiting intake. You turn a job description into a calibration slate:
${SLATE_SIZE} real candidate profiles, deliberately spread across fit bands, each scored on a
fixed rubric with the evidence behind every rating.

The slate's job is to provoke disagreement, not to be a shortlist. Ten near-identical
on-target profiles teach a client nothing. A spread makes them say "yes like that, no not
that", and that reaction is worth more than weeks of sourcing against a misread req.

## Method

1. Dissect the JD. Separate the real title from the posted one. Cut the wish-list down to
   3-6 genuine must-haves — the things a candidate truly cannot lack. Job descriptions
   over-list; the must-have list is not the wish list. Getting this wrong miscalibrates
   every profile that follows.
2. Note the seniority band as years PLUS scope of ownership, not just a title word.
3. Identify where this talent actually sits — the companies whose people are the natural pool.
4. Search with the ${MCP_NAME} tools. **You are under a hard time budget — use at most four
   searches.** Make each one count: vary the angle rather than repeating a query, and pull
   more people per search than you need so you can select for spread. Do not keep refining.
5. Select exactly ${SLATE_SIZE} for band spread:
${BAND_TABLE}
6. Score each person on every rubric dimension:
${RUBRIC_TABLE}

## Scoring rules — these are not negotiable

- Every rating is 0-5 and every rating needs a specific fact from that person's profile in
  its evidence field. No fact, no rating.
- **Unknown is null, never 0.** 0 means the evidence shows they FAIL the dimension. null
  means there is NO evidence either way. Scoring an unknown as 0 buries good candidates
  with sparse profiles; guessing a number invents a fact. Both are worse than admitting the
  gap — the scorer excludes nulls from the denominator, so honesty costs nothing.
- Even when rating is null, write what you looked for and did not find in evidence.
- A profile evidenced below ${EVIDENCE_FLOOR}% of rubric weight will be held out of the
  ranking downstream. That is correct behaviour, not something to avoid by padding ratings.
- **Never invent a person, employer, tenure, or link.** Every candidate must come from an
  actual tool result. A slate with fewer real people beats one padded with plausible ones.

## Recruiter-specified requirements

A request may arrive with an explicit must-have or nice-to-have list. When it does, that
list replaces your own reading of the JD — the recruiter has spoken to the client and you
have not. Copy it into req.must_haves verbatim and score must_have_coverage against
exactly those items, no more and no fewer. Do not silently add a requirement you think is
implied, and do not drop one you judge unrealistic; if a stated must-have looks like it
will empty the market, still score against it and say so in open_questions.

## Recalibration passes

A request may arrive with recruiter feedback on a previous slate. That feedback is the
most reliable signal available — it is a real reaction to real profiles, which beats any
inference you can draw from the JD alone. When it is present:

- Work out what the feedback implies about the search, not just the individuals. "Too
  junior" means the seniority band was read wrong; "wrong industry" means the target
  company set was wrong; "need more hands-on community" means a must-have was
  under-weighted.
- Change the search accordingly — different titles, different companies, a different
  angle — rather than re-running the same query and hoping for different people.
- Say what you changed in weights_rationale, even when the weights themselves did not
  move, so the recruiter can see the adjustment was made.
- Feel free to reweight the rubric if the feedback implies the balance was wrong.

## Reweighting

If the JD explicitly de-emphasises a dimension, override the weights and say why in
weights_rationale. Example: a JD stating "we care about what you have built, not years of
tenure" justifies dropping trajectory_stability and raising must_have_coverage. Overrides
must total 100. Leave weights out entirely when the defaults fit.

## Output

Reply with ONE fenced json block and nothing else outside it. No preamble, no commentary.
It must match this shape exactly:

\`\`\`json
{
  "req": {
    "title": "...", "company": "...", "location": "...", "seniority_band": "...",
    "must_haves": ["..."], "nice_to_haves": ["..."], "target_companies": ["..."],
    "open_questions": ["at most two genuine ambiguities worth asking the client"]
  },
  "weights": { "must_have_coverage": 35, "...": 0 },
  "weights_rationale": "only when weights are overridden",
  "candidates": [
    {
      "name": "...", "title": "...", "company": "...", "location": "...",
      "linkedin": "...",
      "sources": { "supercarl": true },
      "band": "on_target",
      "calibration_question": "the one thing showing this person tests",
      "intro_path": "warm path if the tools surfaced one, else omit",
      "scores": {
        "must_have_coverage": { "rating": 4, "evidence": "specific fact from the profile" },
        "seniority_scope": { "rating": null, "evidence": "what you looked for and did not find" }
      }
    }
  ]
}
\`\`\`

Every candidate needs all ${DIMENSIONS.length} dimensions present. Do not manufacture
uncertainty in open_questions where the JD is clear — omit the field instead.`;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Named-method export, not a default export: Vercel's Node runtime reads a
 * default export as the `(req, res) => void` signature and discards a returned
 * Response. Naming the method also gives us a free 405 on everything else.
 */
export async function POST(request: Request): Promise<Response> {
  // NOTE: this endpoint is intentionally open. It was gated on APP_ACCESS_TOKEN;
  // the owner removed the gate deliberately. Anyone who knows the URL can spend
  // the configured Super Carl credits and Anthropic tokens. To restore the gate,
  // reinstate the token comparison here and the token field in public/index.html.
  const carlToken = process.env.SUPERCARL_API_KEY;
  if (!carlToken) {
    return json({ error: "Server is not configured: SUPERCARL_API_KEY is unset." }, 503);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return json({ error: "Server is not configured: ANTHROPIC_API_KEY is unset." }, 503);
  }

  let body: {
    jd?: unknown;
    location?: unknown;
    notes?: unknown;
    count?: unknown;
    feedback?: unknown;
    previous?: unknown;
    must_haves?: unknown;
    nice_to_haves?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be JSON." }, 400);
  }

  const jd = typeof body.jd === "string" ? body.jd.trim() : "";
  if (jd.length < 120) {
    return json(
      { error: "Paste the full job description — at least a couple of paragraphs." },
      400,
    );
  }

  const requested = typeof body.count === "number" ? Math.round(body.count) : SLATE_SIZE;
  const count = Math.min(Math.max(requested, 3), SLATE_SIZE);

  const location = typeof body.location === "string" ? body.location.trim() : "";
  const notes = typeof body.notes === "string" ? body.notes.trim() : "";

  // The intake schema caps must_haves at 6, so trim here rather than letting the
  // model produce a list that fails validation after a full sourcing run.
  const lines = (v: unknown, cap: number): string[] =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string")
          .map((x) => x.trim())
          .filter(Boolean)
          .slice(0, cap)
      : [];

  const mustHaves = lines(body.must_haves, 6);
  const niceToHaves = lines(body.nice_to_haves, 8);

  const feedback = typeof body.feedback === "string" ? body.feedback.trim() : "";
  const previous = Array.isArray(body.previous)
    ? body.previous.filter((x): x is string => typeof x === "string").slice(0, 12)
    : [];

  const userParts = [`Job description:\n\n${jd}`];
  if (location) userParts.push(`\n\nLocation / remote policy: ${location}`);
  if (notes) userParts.push(`\n\nRecruiter notes: ${notes}`);

  if (mustHaves.length || niceToHaves.length) {
    const parts: string[] = ["\n\n--- RECRUITER-SPECIFIED REQUIREMENTS ---"];
    if (mustHaves.length) {
      parts.push(
        `\nMust-haves. Use these VERBATIM as req.must_haves and score ` +
          `must_have_coverage against exactly this list. Do not re-cut them from the JD, ` +
          `do not reword them, do not add to them:\n` +
          mustHaves.map((m) => `  - ${m}`).join("\n"),
      );
    }
    if (niceToHaves.length) {
      parts.push(
        `\nNice-to-haves. Use these verbatim as req.nice_to_haves. They inform ` +
          `skill_depth and domain_pedigree but never must_have_coverage:\n` +
          niceToHaves.map((n) => `  - ${n}`).join("\n"),
      );
    }
    userParts.push(parts.join("\n"));
  }

  if (feedback) {
    userParts.push(
      `\n\n--- RECALIBRATION ---\nThis is a second pass. The recruiter reviewed the ` +
        `previous slate and said:\n\n"${feedback}"\n\nTreat that as the strongest signal ` +
        `you have — stronger than your own first reading of the JD. Change the search to ` +
        `answer it, do not repeat the same angle.`,
    );
    if (previous.length) {
      userParts.push(
        `\n\nThe previous slate was:\n${previous.map((p) => `  - ${p}`).join("\n")}\n` +
          `Do not return these people again unless the feedback specifically asks for more ` +
          `like one of them.`,
      );
    }
  }

  userParts.push(
    `\n\nSource and score a ${count}-profile calibration slate. Search before you score, ` +
      `and keep to at most 4 searches — this runs under a hard time budget.`,
  );

  const client = new Anthropic();

  try {
    const stream = client.beta.messages.stream({
      model: "claude-opus-5",
      max_tokens: 16000,
      // The whole job must finish inside the platform's function duration cap.
      // Lower effort means fewer, more consolidated tool calls — the single
      // biggest lever on wall-clock here.
      output_config: { effort: "medium" },
      // One explicit breakpoint at the end of the static prefix. Tools render
      // before system, so this caches the toolset and the system prompt together.
      //
      // The bigger win is indirect: once a request uses caching at all, the
      // server inserts its own cache writes after each tool result inside the
      // MCP loop. Without this marker every internal iteration re-reads the
      // whole accumulated search history at full price — which is what made a
      // single run cost as much as it did.
      //
      // Deliberately NOT using top-level automatic caching: it would place the
      // breakpoint after the JD, which is unique per run, so every request
      // would pay the write premium on bytes nothing ever reads back.
      system: [
        { type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: userParts.join("") }],
      mcp_servers: [
        {
          type: "url",
          url: MCP_SERVER_URL,
          name: MCP_NAME,
          authorization_token: carlToken,
        },
      ],
      tools: [{ type: "mcp_toolset", mcp_server_name: MCP_NAME }],
      betas: ["mcp-client-2025-11-20"],
    });

    const message = await stream.finalMessage();

    // Cache health is invisible unless you look: the request still succeeds
    // when caching silently breaks, the bill is just higher. cache_read should
    // be non-zero on any run past the first within the TTL.
    const u = message.usage;
    const usage = {
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    };
    // Claude Opus 5: $5 / MTok in, $25 / MTok out. Cache reads bill at ~0.1x
    // input, writes at ~1.25x.
    const cost =
      (usage.input_tokens * 5 +
        usage.cache_read_input_tokens * 0.5 +
        usage.cache_creation_input_tokens * 6.25 +
        usage.output_tokens * 25) /
      1_000_000;
    console.log("intake usage", JSON.stringify({ ...usage, cost_usd: cost }));

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

    const searches = message.content.filter((b) => b.type === "mcp_tool_use").length;

    // When a slate comes back empty the useful question is what the search tools
    // said — credits exhausted, zero matches, or an error. Without this the
    // failure is indistinguishable from a bad prompt.
    const toolEvidence = message.content
      .filter((b): b is Extract<typeof b, { type: "mcp_tool_result" }> =>
        b.type === "mcp_tool_result")
      .map((b) => {
        // content is `string | BetaTextBlock[]` depending on the tool.
        const raw = b.content;
        const text =
          typeof raw === "string"
            ? raw
            : (raw ?? [])
                .map((c) => (c.type === "text" ? c.text : ""))
                .join(" ");
        return {
          is_error: b.is_error ?? false,
          preview: text.replace(/\s+/g, " ").slice(0, 400),
        };
      });

    if (!text.trim()) {
      return json(
        { error: "The model returned no text — likely ran out of tokens mid-slate.", searches },
        502,
      );
    }

    let parsed: unknown;
    try {
      parsed = extractJson(text);
    } catch (err) {
      return json(
        {
          error: "Could not read a slate out of the model response.",
          detail: err instanceof Error ? err.message : String(err),
          searches,
        },
        502,
      );
    }

    const result = IntakeSchema.safeParse(parsed);
    if (!result.success) {
      return json(
        {
          error: "The generated slate did not match the intake schema.",
          issues: result.error.issues.slice(0, 10),
          searches,
          tool_results: toolEvidence,
          model_said: text.slice(0, 800),
        },
        502,
      );
    }

    return json(
      {
        intake: result.data,
        meta: {
          searches,
          candidates: result.data.candidates.length,
          stop_reason: message.stop_reason,
          usage,
          cost_usd: Math.round(cost * 10000) / 10000,
        },
      },
      200,
    );
  } catch (err) {
    if (err instanceof RateLimitError) {
      return json({ error: "Rate limited by the Claude API. Try again shortly." }, 429);
    }
    if (err instanceof AuthenticationError) {
      // Pass Anthropic's own wording through. "invalid x-api-key" means the key
      // is wrong or revoked; a credit problem reads very differently. Collapsing
      // both into one message just costs another round trip to find out which.
      const key = process.env.ANTHROPIC_API_KEY ?? "";
      return json(
        {
          error: "Claude API rejected the key.",
          detail: err.message,
          key_shape: {
            length: key.length,
            starts_with: key.slice(0, 11),
            has_whitespace: /\s/.test(key),
          },
        },
        502,
      );
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
