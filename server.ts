// server.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pkg from "./package.json" with { type: "json" };
// ----------------- Environment -----------------
const GITEA_BASE_URL = process.env.GITEA_BASE_URL;
const GITEA_TOKEN = process.env.GITEA_TOKEN;
const GITEA_DEFAULT_OWNER = process.env.GITEA_OWNER || "";

if (!GITEA_BASE_URL || !GITEA_TOKEN) {
  console.error("Missing GITEA_BASE_URL or GITEA_TOKEN env vars.");
  process.exit(1);
}

const defaultHeaders: Record<string, string> = {
  Authorization: `token ${GITEA_TOKEN}`,
  "Content-Type": "application/json",
};

// ----------------- Helpers -----------------
function parseGiteaPrUrl(prUrl: string) {
  const m = prUrl.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pulls?\/(\d+)(?:[/].*)?$/i);
  if (!m) throw new Error("Unsupported PR URL format. Expected https://host/owner/repo/pulls/<index>");
  return { owner: decodeURIComponent(m[1]), repo: decodeURIComponent(m[2]), index: Number(m[3]) };
}

async function safeText(res: any) {
  try {
    return await res.text();
  } catch {
    return "<no body>";
  }
}

async function giteaRequest<T>(
  path: string,
  init?: any & { searchParams?: Record<string, string | number | boolean | undefined> }
): Promise<T> {
  const url = new URL(path, GITEA_BASE_URL);
  if (init?.searchParams) {
    for (const [k, v] of Object.entries(init.searchParams)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, {
    ...init,
    headers: {
      ...defaultHeaders,
      ...(init?.headers || {}),
    },
  } as any);
  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(`Gitea ${res.status} ${res.statusText}: ${body}`);
  }
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return (await res.json()) as T;
  }
  return (await res.text()) as unknown as T;
}

// ----------------- Tool definitions -----------------
const GetPullByUrlInput = z.object({
  prUrl: z.string().url().describe("Full PR URL, e.g., https://gitea.example.com/org/repo/pulls/123"),
});

const tools = new Map<
  string,
  {
    name: string;
    description: string;
    inputSchema: object;
    handler: (args: unknown) => Promise<unknown>;
  }
>();

tools.set("gitea_get_pull_by_url", {
  name: "gitea_get_pull_by_url",
  description: "Fetch Gitea pull-request metadata by supplying its full URL.",
  inputSchema: {
    type: "object",
    properties: {
      prUrl: { type: "string", format: "uri" },
    },
    required: ["prUrl"],
    additionalProperties: false,
  },
  handler: async (rawArgs) => {
    const { prUrl } = GetPullByUrlInput.parse(rawArgs);
    const { owner, repo, index } = parseGiteaPrUrl(prUrl);
    const pr = await giteaRequest<any>(`/api/v1/repos/${owner}/${repo}/pulls/${index}.diff?binary=true`);
    return pr;
  },
});

// ----------------- Additional tools -----------------
type Props = Record<string, any>;
const S = { type: "string" } as const;
const N = { type: "integer" } as const;
const B = { type: "boolean" } as const;
const SA = { type: "array", items: { type: "string" } } as const;
const NA = { type: "array", items: { type: "integer" } } as const;

const repoProps: Props = {
  owner: { ...S, description: "Repo owner (defaults to GITEA_OWNER env)" },
  repo: { ...S, description: "Repository name" },
};

function defineTool(
  name: string,
  description: string,
  props: Props,
  required: string[],
  handler: (a: any) => Promise<unknown>,
  withRepo = true
) {
  tools.set(name, {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: withRepo ? { ...repoProps, ...props } : props,
      required: withRepo ? ["repo", ...required] : required,
      additionalProperties: false,
    },
    handler: async (raw) => {
      const a: any = { ...((raw as object) || {}) };
      for (const r of withRepo ? ["repo", ...required] : required) {
        if (a[r] === undefined || a[r] === null || a[r] === "") throw new Error(`Missing required argument: ${r}`);
      }
      if (withRepo) {
        a.owner = a.owner || GITEA_DEFAULT_OWNER;
        if (!a.owner) throw new Error("Missing owner (and GITEA_OWNER not set)");
      }
      return handler(a);
    },
  });
}

const rp = (a: any, sub = "") =>
  `/api/v1/repos/${encodeURIComponent(a.owner)}/${encodeURIComponent(a.repo)}${sub}`;
const pick = (a: any, keys: string[]) =>
  Object.fromEntries(keys.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
const post = (path: string, body: unknown, method = "POST") =>
  giteaRequest<any>(path, { method, body: JSON.stringify(body ?? {}) });

/** Resolve label names or ids into numeric ids. */
async function resolveLabelIds(a: any, labels: (string | number)[]): Promise<number[]> {
  if (labels.every((l) => typeof l === "number")) return labels as number[];
  const all = await giteaRequest<any[]>(rp(a, "/labels"), { searchParams: { limit: 200 } });
  return labels.map((l) => {
    if (typeof l === "number") return l;
    const f = all.find((x) => x.name.toLowerCase() === String(l).toLowerCase());
    if (!f) throw new Error(`Label not found: ${l}`);
    return f.id;
  });
}

// ---- Pull requests ----
defineTool("gitea_list_pulls", "List pull requests in a repository.",
  { state: { ...S, enum: ["open", "closed", "all"] }, page: N, limit: N }, [],
  (a) => giteaRequest(rp(a, "/pulls"), { searchParams: pick(a, ["state", "page", "limit"]) }));

defineTool("gitea_get_pull", "Get pull request metadata by index.", { index: N }, ["index"],
  (a) => giteaRequest(rp(a, `/pulls/${a.index}`)));

defineTool("gitea_get_pull_diff", "Get the diff of a pull request.", { index: N }, ["index"],
  (a) => giteaRequest(rp(a, `/pulls/${a.index}.diff`)));

defineTool("gitea_list_pull_files", "List changed files of a pull request.", { index: N }, ["index"],
  (a) => giteaRequest(rp(a, `/pulls/${a.index}/files`)));

defineTool("gitea_create_pull", "Create a pull request.",
  {
    head: { ...S, description: "Source branch" },
    base: { ...S, description: "Target branch" },
    title: S, body: S, assignees: SA, labels: NA, milestone: N,
  },
  ["head", "base", "title"],
  (a) => post(rp(a, "/pulls"), pick(a, ["head", "base", "title", "body", "assignees", "labels", "milestone"])));

defineTool("gitea_update_pull", "Edit a pull request (title, body, state, base, assignees, labels, milestone).",
  {
    index: N, title: S, body: S, base: S,
    state: { ...S, enum: ["open", "closed"] },
    assignees: SA, labels: NA, milestone: N,
  },
  ["index"],
  (a) => post(rp(a, `/pulls/${a.index}`),
    pick(a, ["title", "body", "base", "state", "assignees", "labels", "milestone"]), "PATCH"));

defineTool("gitea_merge_pull", "Merge a pull request.",
  {
    index: N,
    method: { ...S, enum: ["merge", "rebase", "rebase-merge", "squash", "fast-forward-only"] },
    title: S, message: S, delete_branch_after_merge: B,
  },
  ["index"],
  async (a) => {
    await post(rp(a, `/pulls/${a.index}/merge`), {
      Do: a.method || "merge",
      MergeTitleField: a.title,
      MergeMessageField: a.message,
      delete_branch_after_merge: a.delete_branch_after_merge,
    });
    return { merged: true };
  });

defineTool("gitea_request_reviewers", "Request reviewers on a pull request.",
  { index: N, reviewers: SA, team_reviewers: SA }, ["index"],
  (a) => post(rp(a, `/pulls/${a.index}/requested_reviewers`), pick(a, ["reviewers", "team_reviewers"])));

defineTool("gitea_create_review", "Submit a review on a pull request.",
  {
    index: N, body: S,
    event: { ...S, enum: ["APPROVED", "REQUEST_CHANGES", "COMMENT"] },
    comments: {
      type: "array",
      items: {
        type: "object",
        properties: { path: S, body: S, new_position: N, old_position: N },
        required: ["path", "body"],
      },
    },
  },
  ["index", "event"],
  (a) => post(rp(a, `/pulls/${a.index}/reviews`), pick(a, ["body", "event", "comments"])));

// ---- Comments (PRs & issues share the issue API) ----
defineTool("gitea_add_comment", "Add a comment to a pull request or issue.", { index: N, body: S }, ["index", "body"],
  (a) => post(rp(a, `/issues/${a.index}/comments`), { body: a.body }));

defineTool("gitea_list_comments", "List comments on a pull request or issue.", { index: N }, ["index"],
  (a) => giteaRequest(rp(a, `/issues/${a.index}/comments`)));

// ---- Labels ----
defineTool("gitea_list_labels", "List repository labels.", {}, [],
  (a) => giteaRequest(rp(a, "/labels"), { searchParams: { limit: 200 } }));

defineTool("gitea_create_label", "Create a repository label.",
  { name: S, color: { ...S, description: "Hex color, e.g. #ff0000" }, description: S }, ["name", "color"],
  (a) => post(rp(a, "/labels"), pick(a, ["name", "color", "description"])));

const labelArr = { type: "array", items: { type: ["string", "integer"] }, description: "Label names or ids" };

defineTool("gitea_add_labels", "Add labels to a pull request or issue.", { index: N, labels: labelArr }, ["index", "labels"],
  async (a) => post(rp(a, `/issues/${a.index}/labels`), { labels: await resolveLabelIds(a, a.labels) }));

defineTool("gitea_replace_labels", "Replace all labels on a pull request or issue.", { index: N, labels: labelArr }, ["index", "labels"],
  async (a) => post(rp(a, `/issues/${a.index}/labels`), { labels: await resolveLabelIds(a, a.labels) }, "PUT"));

defineTool("gitea_remove_label", "Remove a label from a pull request or issue.",
  { index: N, label: { type: ["string", "integer"] } }, ["index", "label"],
  async (a) => {
    const [id] = await resolveLabelIds(a, [a.label]);
    await giteaRequest(rp(a, `/issues/${a.index}/labels/${id}`), { method: "DELETE" });
    return { removed: id };
  });

// ---- Tags ----
defineTool("gitea_list_tags", "List repository git tags.", { page: N, limit: N }, [],
  (a) => giteaRequest(rp(a, "/tags"), { searchParams: pick(a, ["page", "limit"]) }));

defineTool("gitea_create_tag", "Create a git tag.",
  { tag_name: S, target: { ...S, description: "Branch or commit SHA" }, message: S }, ["tag_name"],
  (a) => post(rp(a, "/tags"), pick(a, ["tag_name", "target", "message"])));

defineTool("gitea_delete_tag", "Delete a git tag.", { tag: S }, ["tag"],
  async (a) => {
    await giteaRequest(rp(a, `/tags/${encodeURIComponent(a.tag)}`), { method: "DELETE" });
    return { deleted: a.tag };
  });

// ---- Releases ----
defineTool("gitea_list_releases", "List releases.", { page: N, limit: N }, [],
  (a) => giteaRequest(rp(a, "/releases"), { searchParams: pick(a, ["page", "limit"]) }));

defineTool("gitea_create_release", "Create a release (creates the tag if missing).",
  { tag_name: S, target_commitish: S, name: S, body: S, draft: B, prerelease: B }, ["tag_name"],
  (a) => post(rp(a, "/releases"), pick(a, ["tag_name", "target_commitish", "name", "body", "draft", "prerelease"])));

// ---- Branches ----
defineTool("gitea_list_branches", "List branches.", { page: N, limit: N }, [],
  (a) => giteaRequest(rp(a, "/branches"), { searchParams: pick(a, ["page", "limit"]) }));

defineTool("gitea_create_branch", "Create a branch.",
  { new_branch_name: S, old_ref_name: { ...S, description: "Source branch/tag/commit" } }, ["new_branch_name"],
  (a) => post(rp(a, "/branches"), pick(a, ["new_branch_name", "old_ref_name"])));

defineTool("gitea_delete_branch", "Delete a branch.", { branch: S }, ["branch"],
  async (a) => {
    await giteaRequest(rp(a, `/branches/${encodeURIComponent(a.branch)}`), { method: "DELETE" });
    return { deleted: a.branch };
  });

// ---- Issues ----
defineTool("gitea_list_issues", "List issues.",
  { state: { ...S, enum: ["open", "closed", "all"] }, labels: S, q: S, page: N, limit: N }, [],
  (a) => giteaRequest(rp(a, "/issues"), { searchParams: { type: "issues", ...pick(a, ["state", "labels", "q", "page", "limit"]) } }));

defineTool("gitea_create_issue", "Create an issue.",
  { title: S, body: S, assignees: SA, labels: NA, milestone: N }, ["title"],
  (a) => post(rp(a, "/issues"), pick(a, ["title", "body", "assignees", "labels", "milestone"])));

defineTool("gitea_update_issue", "Edit an issue.",
  { index: N, title: S, body: S, state: { ...S, enum: ["open", "closed"] }, assignees: SA, milestone: N }, ["index"],
  (a) => post(rp(a, `/issues/${a.index}`), pick(a, ["title", "body", "state", "assignees", "milestone"]), "PATCH"));

// ---- Repo / files ----
defineTool("gitea_get_repo", "Get repository info.", {}, [], (a) => giteaRequest(rp(a)));

defineTool("gitea_get_file", "Get raw file content.", { path: S, ref: S }, ["path"],
  (a) => giteaRequest(rp(a, `/raw/${a.path.split("/").map(encodeURIComponent).join("/")}`),
    { searchParams: pick(a, ["ref"]) }));

// ----------------- Request schemas -----------------
const ToolsListRequest = z.object({
  method: z.literal("tools/list"),
  params: z.object({}).optional(),
});

const ToolsCallRequest = z.object({
  method: z.literal("tools/call"),
  params: z.object({
    name: z.string(),
    arguments: z.unknown().optional(),
  }),
});

// ----------------- Server wiring -----------------
// ----------------- Server wiring -----------------
const transport = new StdioServerTransport();

const server = new Server(
  {
    name: pkg.name ?? "mcp-gitea-server",
    version: pkg.version ?? "1.0.0",
  },
  {
    capabilities: {
      tools: { listChanged: true },
    },
    instructions:
      "Gitea MCP server. Call tools/list to discover tools, then tools/call with { name, arguments }.",
  }
);
// tools/list
server.setRequestHandler(ToolsListRequest, async () => {
  const list = Array.from(tools.values()).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
  return { tools: list };
});

// tools/call
server.setRequestHandler(ToolsCallRequest, async (req) => {
  const name = req.params?.name;
  const args = req.params?.arguments ?? {};
  const tool = name ? tools.get(name) : undefined;
  if (!tool) throw new Error(`Unknown tool: ${name ?? "<missing>"}`);

  const result = await tool.handler(args);
  return {
    content: [
      {
        type: "text",
        text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
      },
    ],
  };
});

server
  .connect(transport)
  .then(() => server.sendToolListChanged())
  .catch((err: unknown) => {
    console.error("Failed to start MCP server:", err);
    process.exit(1);
  });