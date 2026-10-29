import Anthropic, { APIError, AuthenticationError, RateLimitError } from "@anthropic-ai/sdk";

/**
 * POST /api/people
 *
 * Body: { company: string, titles: string[], location?: string, limit?: number }
 *
 * Turns one cell of the org map into a prospecting list: the people, by name,
 * with where they are, what they are called, how long they have been in the
 * seat and a link to them.
 *
 * Super Carl rather than Apollo because Apollo's People Search cannot do this.
 * It returns `last_name_obfuscated` ("Hu***n"), no LinkedIn URL and no location
 * value — only has_city booleans. Apollo counts; Super Carl names.
 *
 * Runs through the Claude MCP connector, the pattern already proven in this
 * repo. That costs Claude tokens on top of Super Carl credits, which is why
 * this is a per-cell action the user asks for rather than part of the map.
 */

export const maxDuration = 120;

const MODEL = process.env.INTAKE_MODEL || "claude-sonnet-5";
const MCP_SERVER_URL = "https://api.supercarl.ai/mcp";
const MCP_NAME = "supercarl";

const MAX_TITLES = 8;
const MAX_LIMIT = 25;

const SYSTEM = `You build a prospecting list of salespeople from Super Carl.

Make ONE ${MCP_NAME} people_search call and report its rows.

The single exception: if a location was given and that call returns ZERO
people, make exactly one more call with the location filter removed and
everything else identical, then set "location_dropped": true. Super Carl's
structured location filter is strict and suppresses its own profile-text
fallback, so a remote-heavy employer can return nothing for a city while
having hundreds of people overall. An empty list is far less useful to a
recruiter than the same list unfiltered and labelled. Never retry for any
other reason, and never widen the company or the titles.

Shape the call like this:

  filters.where.job_titles.include = the given titles, current_only true
  filters.where.locations.include  = [the location], only if one was given
  filters.companies = [{ relation: "current_employment", operator: "include",
                         where: { identity: { domain: "<domain>" } } }]
      — use identity.domain when the company is a domain, identity.name when
        it is a name
  fields = ["name","location","current_title","current_company","linkedin_url",
            "current_role_tenure_months","years_experience_months","headline"]
  limit  = the given limit

## Rules

**Every row comes from the tool result.** Never invent or complete a name, a
link, a location or a tenure. If a field is missing, leave it null.

**Flag stale employer rows, do not drop them.** A row carrying
current_employment_relation_company_differs_from_current_company matched the
target company on an employment record while its current_company says
something else. That usually means the record is out of date or the person has
moved. Set "employer_conflict": true on it and copy its current_company
verbatim, so the recruiter can judge rather than be misled.

**Report the pool size.** The result carries a count and an exportable_people
value for the whole matching pool. Put that in total_matching, and set
truncated true when it exceeds the rows you return.

## Output

JSON only. No prose, no code fence:

{
  "people": [
    { "name": "...", "location": "...", "title": "...", "company": "...",
      "linkedin_url": "...", "tenure_months": 20, "experience_months": 156,
      "headline": "...", "employer_conflict": false }
  ],
  "total_matching": 0,
  "truncated": false,
  "location_dropped": false,
  "note": "one sentence if the search was degraded or the filters were altered, else empty"
}`;

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

  let body: { company?: unknown; titles?: unknown; location?: unknown; limit?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be JSON." }, 400);
  }

  const company = typeof body.company === "string" ? body.company.trim() : "";
  const titles = list(body.titles, MAX_TITLES);
  const location = typeof body.location === "string" ? body.location.trim() : "";
  const rawLimit = typeof body.limit === "number" ? Math.floor(body.limit) : 25;
  const limit = Math.min(Math.max(rawLimit, 1), MAX_LIMIT);

  if (!company) return json({ error: "No company given." }, 400);
  if (!titles.length) return json({ error: "No titles given." }, 400);

  const isDomain = /^[^\s@]+\.[a-z]{2,}$/i.test(company);

  const client = new Anthropic();

  try {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      output_config: { effort: "low" },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content:
            `Company: ${company}  (${isDomain ? "a domain — use identity.domain" : "a name — use identity.name"})\n` +
            `Titles:\n${titles.map((t) => `  - ${t}`).join("\n")}\n` +
            (location ? `Location: ${location}\n` : "Location: any\n") +
            `Rows to return: ${limit}`,
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
    // Outcome as well as spend: the first live failure here was invisible in
    // the logs because only token usage was being recorded.
    const outcome = (() => {
      try {
        const t = message.content
          .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
          .map((b) => b.text).join("\n");
        const o = extractJson(t) as { people?: unknown[]; total_matching?: number; location_dropped?: boolean };
        return {
          returned: Array.isArray(o.people) ? o.people.length : -1,
          total_matching: o.total_matching ?? null,
          location_dropped: o.location_dropped ?? false,
        };
      } catch {
        return { returned: -1, total_matching: null, location_dropped: false };
      }
    })();
    console.log(
      "people",
      JSON.stringify({ model: MODEL, company, location: location || null, limit, ...outcome, ...usage, cost_usd: cost }),
    );

    if (message.stop_reason === "max_tokens") {
      return json({ error: "The list was cut off before it finished. Ask for fewer rows." }, 502);
    }

    const text = message.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    if (!text.trim()) return json({ error: "Super Carl returned nothing usable." }, 502);

    let parsed: unknown;
    try {
      parsed = extractJson(text);
    } catch (err) {
      return json(
        {
          error: "Could not read the list.",
          detail: err instanceof Error ? err.message : String(err),
          model_said: text.slice(0, 600),
        },
        502,
      );
    }

    return json({ ...(parsed as object), cost_usd: Math.round(cost * 10000) / 10000 }, 200);
  } catch (err) {
    if (err instanceof RateLimitError) return json({ error: "Rate limited. Try again shortly." }, 429);
    if (err instanceof AuthenticationError) return json({ error: "The Claude API key was rejected." }, 401);
    if (err instanceof APIError) return json({ error: `Claude API error ${err.status}.`, detail: err.message }, 502);
    return json(
      { error: "The list failed.", detail: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}
