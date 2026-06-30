import { ApifyClient } from "apify-client";
import type { SpotCheckReport } from "./spot-check";
import { VERIFICATION_THRESHOLDS } from "./verification";

function pickSamples<T>(items: T[], size: number): T[] {
  if (items.length <= size) return [...items];
  const copy = [...items];
  const out: T[] = [];
  while (out.length < size && copy.length) {
    const i = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(i, 1)[0]);
  }
  return out;
}

function normalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];
}

function urlMatchesDomain(url: string, domain: string): boolean {
  if (!url) return false;
  try {
    const host = new URL(url.startsWith("http") ? url : `https://${url}`).hostname.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return url.toLowerCase().includes(domain);
  }
}

async function checkKeywordPosition(
  client: ApifyClient,
  actorId: string,
  domain: string,
  keyword: string
): Promise<number | null> {
  const run = await client.actor(actorId).call(
    {
      queries: keyword,
      maxPagesPerQuery: 3,
      resultsPerPage: 10,
      languageCode: "en",
      countryCode: "ca",
      mobileResults: false,
      proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ["GOOGLE_SERP"] },
    },
    { waitSecs: 120 }
  );
  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  const normalizedDomain = normalizeDomain(domain);

  for (let pageIndex = 0; pageIndex < items.length; pageIndex++) {
    const page = items[pageIndex] as Record<string, unknown>;
    const organicResults = (page.organicResults as Record<string, unknown>[]) || [];
    for (const result of organicResults) {
      const url = String(result.url || "");
      if (!urlMatchesDomain(url, normalizedDomain)) continue;
      const pagePosition = typeof result.position === "number" ? result.position : null;
      return pagePosition != null ? pageIndex * 10 + pagePosition : null;
    }
  }
  return null;
}

/** Re-run SERP checks on a sample of keywords and compare positions. */
export async function crossVerifySerpResults(
  results: { keyword: string; position: number | null }[],
  domain: string
): Promise<SpotCheckReport> {
  const token = process.env.APIFY_API_TOKEN;
  const actorId = process.env.APIFY_VERIFY_ACTOR_ID || process.env.APIFY_ACTOR_ID || "apify~google-search-scraper";
  if (!token || results.length === 0) {
    return { samplesChecked: 0, passed: true, issues: [] };
  }

  const samples = pickSamples(results, Math.min(3, results.length));
  const client = new ApifyClient({ token });
  const issues: string[] = [];
  let matched = 0;
  const tol = VERIFICATION_THRESHOLDS.serpPositionTolerance;

  for (const sample of samples) {
    try {
      const freshPosition = await checkKeywordPosition(client, actorId, domain, sample.keyword);
      const original = sample.position;

      if (original == null && freshPosition == null) {
        matched += 1;
      } else if (original != null && freshPosition != null && Math.abs(original - freshPosition) <= tol) {
        matched += 1;
      } else {
        issues.push(
          `"${sample.keyword}": position ${original ?? "NR"} vs re-check ${freshPosition ?? "NR"}`
        );
      }
    } catch (err) {
      issues.push(`"${sample.keyword}": re-check failed (${err instanceof Error ? err.message : "error"})`);
    }
  }

  const ratio = samples.length ? matched / samples.length : 1;
  return {
    samplesChecked: samples.length,
    passed: ratio >= VERIFICATION_THRESHOLDS.minCrossMatchRatio,
    issues,
    rescrapeChecked: samples.length,
    rescrapeMatched: matched,
  };
}
