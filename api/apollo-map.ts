import {
  APOLLO_MAX_PER_PAGE,
  APOLLO_ORG_SEARCH_URL,
  APOLLO_SEARCH_URL,
  SENIORITIES,
  aggregate,
  buildOrgSearchParams,
  buildSearchParams,
  type ApolloOrg,
  type ApolloOrgResponse,
  type ApolloPerson,
  type ApolloSearchResponse,
} from "../lib/apollo.js";

/**
 * POST /api/apollo-map
 *
 * Body: { titles: string[], locations: string[], locationMode?, seniorities?,
 *         employeeRanges?, exactTitles?, depth? }
 *
 * Maps where a title sits: given titles and locations, returns the total size
 * of that market plus the employers ranked by how many matching people they
 * have. Apollo's People Search costs 0 credits, so depth is bounded by the
 * rate limit and the clock rather than by spend.
 */

/** Several sequential Apollo pages; well short of the sourcing endpoint's needs. */
export const maxDuration = 60;

/** Pages of 100. Ten is 1,000 people — plenty to rank employers. */
const MAX_DEPTH = 10;

/** Each resolve call costs 1 Apollo credit, so the name list is kept short. */
const MAX_NAME_LOOKUPS = 5;
/** organization_ids[] is only useful while it stays a filter, not a phone book. */
const MAX_ORG_IDS = 200;

/** Anything with a dot and no spaces is a domain; People Search takes those directly. */
function looksLikeDomain(s: string): boolean {
  return /^[^\s@]+\.[a-z]{2,}$/i.test(s);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Trim, drop blanks, de-duplicate, cap. Apollo 422s on empty array entries. */
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

export async function POST(request: Request): Promise<Response> {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) {
    return json(
      {
        error:
          "APOLLO_API_KEY is not set on this deployment. Add it in the Vercel " +
          "project's environment variables and redeploy.",
      },
      503,
    );
  }

  let body: {
    titles?: unknown;
    companyNames?: unknown;
    industries?: unknown;
    locations?: unknown;
    locationMode?: unknown;
    seniorities?: unknown;
    employeeRanges?: unknown;
    exactTitles?: unknown;
    depth?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be JSON." }, 400);
  }

  const titles = list(body.titles, 20);
  const locations = list(body.locations, 20);

  if (!titles.length) {
    return json({ error: "Give at least one job title to map." }, 400);
  }

  // Unknown seniorities are a 422 from Apollo, which surfaces as a generic
  // failure well after the request is out the door. Drop them here instead.
  const seniorities = list(body.seniorities, SENIORITIES.length).filter(
    (s): s is (typeof SENIORITIES)[number] =>
      (SENIORITIES as readonly string[]).includes(s),
  );

  // Apollo's format is "min,max" — anything else is rejected.
  const employeeRanges = list(body.employeeRanges, 10).filter((r) =>
    /^\d+,\d+$/.test(r),
  );

  const companyNames = list(body.companyNames, MAX_NAME_LOOKUPS);
  const industries = list(body.industries, 10);
  const locationMode = body.locationMode === "organization" ? "organization" : "person";
  const exactTitles = body.exactTitles === true;

  const rawDepth = typeof body.depth === "number" ? Math.floor(body.depth) : 3;
  const depth = Math.min(Math.max(rawDepth, 1), MAX_DEPTH);

  // Domains need no lookup; names and sectors do. Splitting here means a user
  // who pastes "calm.com" spends nothing to filter by it.
  const domains = companyNames.filter(looksLikeDomain);
  const namesToResolve = companyNames.filter((n) => !looksLikeDomain(n));

  const organizationIds: string[] = [];
  const resolvedCompanies: { name: string; domain: string | null }[] = [];
  let orgCreditsSpent = 0;

  try {
    // One call per name (Apollo takes a single q_organization_name), plus one
    // for a sector-only search. Sector keywords ride along with each name so
    // "Calm" + "mental health" narrows rather than widens.
    const lookups: { name?: string }[] = namesToResolve.length
      ? namesToResolve.map((name) => ({ name }))
      : industries.length
        ? [{}]
        : [];

    for (const lookup of lookups) {
      const params = buildOrgSearchParams({
        name: lookup.name,
        keywords: industries,
        locations: locationMode === "organization" ? locations : [],
        perPage: 25,
      });
      const res = await fetch(`${APOLLO_ORG_SEARCH_URL}?${params.toString()}`, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          accept: "application/json",
          "content-type": "application/json",
        },
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300);
        return json(
          {
            error:
              res.status === 403
                ? "That Apollo key cannot search companies, which is needed to " +
                  "resolve a company name or sector into a filter."
                : `Apollo company search returned ${res.status}.`,
            detail,
          },
          res.status === 429 ? 429 : 502,
        );
      }
      orgCreditsSpent += 1;
      const payload = (await res.json()) as ApolloOrgResponse;
      const orgs: ApolloOrg[] = [
        ...(payload.organizations ?? []),
        ...(payload.accounts ?? []),
      ];
      for (const org of orgs) {
        if (!org.id || organizationIds.includes(org.id)) continue;
        if (organizationIds.length >= MAX_ORG_IDS) break;
        organizationIds.push(org.id);
        resolvedCompanies.push({
          name: org.name ?? "",
          domain: org.primary_domain ?? null,
        });
      }
    }
  } catch (err) {
    return json(
      {
        error: "Could not reach Apollo to resolve companies.",
        detail: err instanceof Error ? err.message : String(err),
      },
      504,
    );
  }

  // Asking for a company that Apollo cannot find would otherwise silently drop
  // the filter and map the whole market instead — the opposite of the request.
  if ((namesToResolve.length || industries.length) && !organizationIds.length) {
    return json(
      {
        error:
          "Apollo found no companies matching " +
          (namesToResolve.length
            ? "that name"
            : "that industry keyword") +
          ". Nothing was searched, because mapping without the filter would " +
          "have returned the whole market instead.",
        orgCreditsSpent,
      },
      422,
    );
  }

  const people: ApolloPerson[] = [];
  let totalEntries = 0;
  let pagesFetched = 0;

  try {
    for (let page = 1; page <= depth; page++) {
      const params = buildSearchParams({
        titles,
        locations,
        locationMode,
        seniorities,
        employeeRanges,
        exactTitles,
        organizationIds,
        domains,
        page,
        perPage: APOLLO_MAX_PER_PAGE,
      });

      const res = await fetch(`${APOLLO_SEARCH_URL}?${params.toString()}`, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          accept: "application/json",
          "content-type": "application/json",
        },
      });

      if (!res.ok) {
        // Anything after page 1 has already produced a usable sample. Keep it
        // and report the partial rather than throwing away a good answer.
        if (pagesFetched > 0) break;

        const detail = (await res.text()).slice(0, 300);
        const message =
          res.status === 401
            ? "Apollo rejected the API key."
            : res.status === 403
              ? "That Apollo key lacks access to People Search. It needs the " +
                "mixed_people_api_search scope, or a master key."
              : res.status === 422
                ? "Apollo rejected the search filters."
                : res.status === 429
                  ? "Apollo rate limit reached. Wait a minute and try again."
                  : `Apollo returned ${res.status}.`;
        return json({ error: message, detail }, res.status === 429 ? 429 : 502);
      }

      const payload = (await res.json()) as ApolloSearchResponse;
      const batch = Array.isArray(payload.people) ? payload.people : [];
      if (typeof payload.total_entries === "number") {
        totalEntries = payload.total_entries;
      }
      people.push(...batch);
      pagesFetched += 1;

      // A short page is the last page; asking for another wastes a request
      // against the hourly limit.
      if (batch.length < APOLLO_MAX_PER_PAGE) break;
    }
  } catch (err) {
    return json(
      {
        error: "Could not reach Apollo.",
        detail: err instanceof Error ? err.message : String(err),
      },
      504,
    );
  }

  const result = aggregate(people);

  console.log(
    "apollo-map",
    JSON.stringify({
      titles: titles.length,
      locations: locations.length,
      locationMode,
      depth,
      pagesFetched,
      sampled: result.sampled,
      companies: result.distinctCompanies,
      totalEntries,
      orgCreditsSpent,
    }),
  );

  return json(
    {
      ...result,
      totalEntries,
      pagesFetched,
      // The ranking is drawn from the sample, not the whole market. Say so in
      // the payload so the UI cannot quietly present it as complete.
      partial: totalEntries > result.sampled,
      orgCreditsSpent,
      resolvedCompanies,
      query: {
        titles, locations, locationMode, seniorities, employeeRanges,
        exactTitles, companyNames, industries, domains,
      },
    },
    200,
  );
}
