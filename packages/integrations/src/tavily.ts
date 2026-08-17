const TAVILY_API_URL = "https://api.tavily.com/search";

export interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
}

export class TavilyClient {
  constructor(private readonly apiKey: string) {}

  async search(
    query: string,
    maxResults = 5,
  ): Promise<{ answer: string | null; results: TavilySearchResult[] } | { error: string }> {
    const response = await fetch(TAVILY_API_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: this.apiKey,
        query,
        max_results: maxResults,
        search_depth: "basic",
        include_answer: true,
        include_raw_content: false,
      }),
    });

    const json = await response.json();
    if (!response.ok) {
      return { error: json.detail?.error ?? json.message ?? `Tavily API error (${response.status})` };
    }

    const results: TavilySearchResult[] = (json.results ?? []).map((r: any) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      content: r.content ?? "",
    }));

    return { answer: json.answer ?? null, results };
  }
}
