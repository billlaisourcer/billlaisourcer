import Anthropic, { APIError, AuthenticationError, RateLimitError } from "@anthropic-ai/sdk";

/**
 * POST /api/network-check
 *
 * Body: { companies: string[], titles: string[] }
 *
 * Second opinion on an Apollo map. Takes the employers Apollo ranked and asks
 * Super Carl whether it independently sees the same talent there — and where
 * the account's LinkedIn/Gmail/calendar are connected, whether there is a path
 * in.
 *
 * Runs through the Claude MCP connector rather than speaking MCP directly,
 * which is the pattern already proven in api/intake.ts.
 *
 * Two things a caller should know, both observed against the live API:
 *
 * 1. Company names are matched loosely. A search for "Headspace" also returns
 *    the unrelated Australian youth service of the same name. Super Carl flags
 *    those rows itself, and the prompt below requires them to be separated
 *    rather than counted.
 * 2. The network signals are only as good as the account's connections. With
 *    no LinkedIn or Gmail linked to Super Carl every row comes back
 *    not_connected, which means "unknown", not "no path".
 */

export const maxDuration = 120;

const MODEL = process.env.INTAKE_MODEL || "claude-sonnet-5";
const MCP_SERVER_URL = "https://api.supercarl.ai/mcp";
const MCP_NAME = "supercarl";

/** Super Carl takes at most 100 names in one identity filter. */
const MAX_COMPANIES = 40;
const MAX_TITLES = 8;

const SYSTEM = `You cross-reference a list of employers against Super Carl's people index.

You will be given company names and job titles. Make exactly ONE ${MCP_NAME}
people_search call, then report what came back. Do not make a second search.

Shape the call like this:

  filters.where.job_titles.include = the given titles, current_only true
  filters.companies = [{ relation: "current_employment", operator: "include",
                         where: { identity: { names: [the given companies] } } }]
  fields = ["name","current_title","current_company","linkedin_url",
            "connection_degree","has_previous_correspondence","correspondence_count"]
  relationship_detail = "summary"
  limit = 25

## Reading the result

**Name collisions are real and must not be counted as matches.** Company names
are matched loosely, so a search for one company can return people at an
unrelated company with the same name. A row carrying
current_employment_relation_company_differs_from_current_company, or whose
matched employer is plainly a different organisation from the one asked for,
is a collision. Put those under \`collisions\`, never under \`companies\`.

**Absent network data is unknown, not absent.** connection_status
"not_connected", a null connection_degree, or calendar_connected false mean
Super Carl has nothing linked for this account — not that no path exists.
Never describe someone as unreachable on that basis. If every row looks like
that, say so once in \`network_note\`.

## Output

Reply with JSON only, no prose, no code fence:

{
  "companies": [
    { "name": "...", "found": 3, "first_degree": 0, "prior_contact": 0,
      "people": [{ "name": "...", "title": "...", "linkedin_url": "..." }] }
  ],
  "collisions": [{ "asked": "...", "matched": "...", "note": "..." }],
  "total_found": 0,
  "network_note": "one sentence, or empty if network data was present"
}

Every person must come from a tool result. Never invent a name or a link.`;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function list(value: unknown, cap: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const s = item.replace(/\s+/g, " ").trim();
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

/** The model is told not to fence its JSON; tolerate it anyway. */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in response");
  return JSON.parse(body.slice(start, end + 1));
}

export async function POST(request: Request): Promise<Response> {
  const carlToken = process.env.SUPERCARL_API_KEY;
  if (!carlToken) {
    return json({ error: "SUPERCARL_API_KEY is not set on this deployment." }, 503);
  }

  let body: { companies?: unknown; titles?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be JSON." }, 400);
  }

  const companies = list(body.companies, MAX_COMPANIES);
  const titles = list(body.titles, MAX_TITLES);

  if (!companies.length) return json({ error: "No companies to check." }, 400);
  if (!titles.length) return json({ error: "No titles to check against." }, 400);

  const client = new Anthropic();

  try {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: "low" },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content:
            `Companies:\n${companies.map((c) => `  - ${c}`).join("\n")}\n\n` +
            `Titles:\n${titles.map((t) => `  - ${t}`).join("\n")}`,
        },
      ],
      mcp_servers: [
        { type: "url", url: MCP_SERVER_URL, name: MCP_NAME, authorization_token: carlToken },
      ],
      tools: [{ type: "mcp_toolset", mcp_server_name: MCP_NAME }],
      betas: ["mcp-client-2025-11-20"],
    });

    const message = await stream.finalMessage();

    const u = message.usage;
    const usage = {
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    };
    const RATES: Record<string, { in: number; out: number }> = {
      "claude-opus-5": { in: 5, out: 25 },
      "claude-sonnet-5": { in: 2, out: 10 },
      "claude-haiku-4-5": { in: 1, out: 5 },
    };
    const rate = RATES[MODEL] ?? { in: 2, out: 10 };
    const cost =
      (usage.input_tokens * rate.in +
        usage.cache_read_input_tokens * rate.in * 0.1 +
        usage.cache_creation_input_tokens * rate.in * 1.25 +
        usage.output_tokens * rate.out) /
      1_000_000;
    console.log(
      "network-check",
      JSON.stringify({ model: MODEL, companies: companies.length, ...usage, cost_usd: cost }),
    );

    if (message.stop_reason === "max_tokens") {
      return json({ error: "The cross-reference was cut off before it finished." }, 502);
    }

    const text = message.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    if (!text.trim()) {
      return json({ error: "Super Carl returned nothing usable." }, 502);
    }

    let parsed: unknown;
    try {
      parsed = extractJson(text);
    } catch (err) {
      return json(
        {
          error: "Could not read the cross-reference result.",
          detail: err instanceof Error ? err.message : String(err),
          model_said: text.slice(0, 600),
        },
        502,
      );
    }

    return json(
      { ...(parsed as object), cost_usd: Math.round(cost * 10000) / 10000 },
      200,
    );
  } catch (err) {
    if (err instanceof RateLimitError) {
      return json({ error: "Rate limited. Try again shortly." }, 429);
    }
    if (err instanceof AuthenticationError) {
      return json({ error: "The Claude API key was rejected." }, 401);
    }
    if (err instanceof APIError) {
      return json({ error: `Claude API error ${err.status}.`, detail: err.message }, 502);
    }
    return json(
      { error: "The cross-reference failed.", detail: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}
