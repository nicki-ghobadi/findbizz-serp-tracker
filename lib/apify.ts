import { ApifyClient } from "apify-client";

export interface SerpResult {
  keyword: string;
  position: number | null;
  url: string;
  title: string;
  description: string;
  date: string;
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

export async function checkRankings(
  domain: string,
  keywords: string[]
): Promise<SerpResult[]> {
  const token = process.env.APIFY_API_TOKEN;
  const actorId = process.env.APIFY_ACTOR_ID || "apify~google-search-scraper";
  if (!token) throw new Error("Missing APIFY_API_TOKEN");

  const client = new ApifyClient({ token });
  const normalizedDomain = normalizeDomain(domain);
  const results: SerpResult[] = [];
  const today = new Date().toISOString().split("T")[0];

  for (const keyword of keywords) {
    const run = await client.actor(actorId).call({
      queries: keyword,
      maxPagesPerQuery: 3,
      resultsPerPage: 10,
      languageCode: "en",
      countryCode: "ca",
      mobileResults: false,
      proxyConfiguration: {
        useApifyProxy: true,
        apifyProxyGroups: ["GOOGLE_SERP"],
      },
    });

    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    const resultsPerPage = 10;

    let match: SerpResult | null = null;

    for (let pageIndex = 0; pageIndex < items.length; pageIndex++) {
      const page = items[pageIndex] as Record<string, unknown>;
      const organicResults = (page.organicResults as Record<string, unknown>[]) || [];
      for (const result of organicResults) {
        const url = String(result.url || "");
        if (!urlMatchesDomain(url, normalizedDomain)) continue;

        const pagePosition = typeof result.position === "number" ? result.position : null;
        const globalPosition =
          pagePosition != null ? pageIndex * resultsPerPage + pagePosition : null;

        match = {
          keyword,
          position: globalPosition,
          url,
          title: String(result.title || ""),
          description: String(result.description || ""),
          date: today,
        };
        break;
      }
      if (match) break;
    }

    results.push(
      match || {
        keyword,
        position: null,
        url: "",
        title: "Not in top 30",
        description: "",
        date: today,
      }
    );
  }

  return results;
}

import { sanitizeCsvCell } from "./sanitize";

export function rankingsToCSV(results: SerpResult[]): string {
  const header = ["Keyword", "Position", "URL", "Title", "Date"];
  const rows = results.map((r) => [
    sanitizeCsvCell(r.keyword),
    r.position !== null ? String(r.position) : "Not ranked",
    sanitizeCsvCell(r.url),
    sanitizeCsvCell(r.title),
    r.date,
  ]);
  return [header.join(","), ...rows.map((r) => r.join(","))].join("\n");
}
