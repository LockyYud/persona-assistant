const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

export interface NotionSearchResult {
  id: string;
  type: string;
  title: string;
  url: string;
}

/** Raw Notion page object, kept loose since only a few fields are consumed. */
export interface NotionPage {
  id: string;
  url: string;
  last_edited_time: string;
  properties: Record<string, unknown>;
}

export class NotionClient {
  constructor(private readonly apiKey: string) {}

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const response = await fetch(`${NOTION_API_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "notion-version": NOTION_VERSION,
        "content-type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const json = await response.json();
    if (!response.ok) {
      return { error: json.message ?? `Notion API error (${response.status})` };
    }
    return json;
  }

  async search(query: string, limit = 5): Promise<{ results: NotionSearchResult[] } | { error: string }> {
    const resp = await this.request("POST", "/search", { query, page_size: limit });
    if (resp.error) return { error: resp.error };

    const results: NotionSearchResult[] = (resp.results ?? []).map((r: any) => {
      const titleProp = Object.values(r.properties ?? {}).find(
        (p: any) => p?.type === "title",
      ) as { title?: Array<{ plain_text: string }> } | undefined;
      const title =
        titleProp?.title?.[0]?.plain_text ??
        r.properties?.title?.title?.[0]?.plain_text ??
        "(untitled)";
      return { id: r.id, type: r.object, title, url: r.url };
    });

    return { results };
  }

  async getPage(pageId: string): Promise<{ title: string; content: string } | { error: string }> {
    const normalizedId = pageId.replace(/-/g, "");
    const page = await this.request("GET", `/pages/${normalizedId}`);
    if (page.error) return { error: page.error };

    const titleProp = Object.values(page.properties ?? {}).find(
      (p: any) => p?.type === "title",
    ) as { title?: Array<{ plain_text: string }> } | undefined;
    const title = titleProp?.title?.[0]?.plain_text ?? "(untitled)";

    const blocksResp = await this.request("GET", `/blocks/${normalizedId}/children`);
    const blocks = blocksResp.error ? [] : (blocksResp.results ?? []);

    const content = blocks
      .map((block: any) => {
        const richText = block[block.type]?.rich_text ?? [];
        return richText.map((t: any) => t.plain_text ?? "").join("");
      })
      .filter((line: string) => line.length > 0)
      .join("\n");

    return { title, content };
  }

  /**
   * Pages from a database, newest-edited first. Notion's query API can't
   * filter by last_edited_time directly, so callers paginate this sorted
   * list themselves and stop once they reach a page older than their cursor
   * (see notion-sync.ts).
   */
  async queryDatabase(
    databaseId: string,
    opts: { pageSize?: number; startCursor?: string } = {},
  ): Promise<{ pages: NotionPage[]; nextCursor: string | null } | { error: string }> {
    const resp = await this.request("POST", `/databases/${databaseId.replace(/-/g, "")}/query`, {
      page_size: opts.pageSize ?? 20,
      start_cursor: opts.startCursor,
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    });
    if (resp.error) return { error: resp.error };

    return {
      pages: resp.results ?? [],
      nextCursor: resp.has_more ? (resp.next_cursor ?? null) : null,
    };
  }

  async createPage(
    databaseId: string,
    properties: Record<string, unknown>,
  ): Promise<NotionPage | { error: string }> {
    const resp = await this.request("POST", "/pages", {
      parent: { database_id: databaseId.replace(/-/g, "") },
      properties,
    });
    if (resp.error) return { error: resp.error };
    return resp;
  }

  async updatePage(
    pageId: string,
    properties: Record<string, unknown>,
  ): Promise<NotionPage | { error: string }> {
    const resp = await this.request("PATCH", `/pages/${pageId.replace(/-/g, "")}`, { properties });
    if (resp.error) return { error: resp.error };
    return resp;
  }
}
