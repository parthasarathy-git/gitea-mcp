# Gitea MCP Server

A Model Context Protocol (MCP) server that exposes Gitea repository operations as tools for MCP-compatible clients.

The server communicates over standard input/output and uses the Gitea REST API. It supports pull requests, issues, comments, labels, tags, releases, branches, repositories, and file access.

## Requirements

- Node.js 18 or newer
- A Gitea instance
- A Gitea personal access token

## Installation

```powershell
npm install
```

## Configuration

Set these environment variables before starting the server:

| Variable | Required | Description |
|---|---:|---|
| `GITEA_BASE_URL` | Yes | Gitea base URL, for example `https://gitea.example.com` |
| `GITEA_TOKEN` | Yes | Gitea personal access token |
| `GITEA_OWNER` | No | Default repository owner or organization |

PowerShell example:

```powershell
$env:GITEA_BASE_URL = "https://gitea.example.com"
$env:GITEA_TOKEN = "your-personal-access-token"
$env:GITEA_OWNER = "example-org"
```

Keep the token out of source control and version-controlled MCP configuration files. If `GITEA_OWNER` is set, repository tools may omit `owner`; otherwise, pass `owner` with each repository tool call.

## Running

Development mode:

```powershell
npm run dev
```

Production build and start:

```powershell
npm run build
npm start
```

The server must be launched by an MCP client through stdio. Do not connect to it as an HTTP server.

## VS Code MCP Configuration

Add the server to your MCP client configuration, for example:

```json
{
  "servers": {
    "gitea": {
      "type": "stdio",
      "command": "node",
      "args": [
        "C:\\path\\to\\gitea-mcp\\dist\\server.js"
      ],
      "env": {
        "GITEA_BASE_URL": "https://gitea.example.com",
        "GITEA_TOKEN": "your-personal-access-token",
        "GITEA_OWNER": "example-org"
      }
    }
  }
}
```

For development, `args` may point to `C:\\path\\to\\gitea-mcp\\node_modules\\tsx\\dist\\cli.mjs` with `server.ts` as the first argument, or use the built output above after running `npm run build`.

## Available Tools

### Pull requests

- `gitea_get_pull_by_url`
- `gitea_list_pulls`
- `gitea_get_pull`
- `gitea_get_pull_diff`
- `gitea_list_pull_files`
- `gitea_create_pull`
- `gitea_update_pull`
- `gitea_merge_pull`
- `gitea_request_reviewers`
- `gitea_create_review`

### Comments and labels

- `gitea_add_comment`
- `gitea_list_comments`
- `gitea_list_labels`
- `gitea_create_label`
- `gitea_add_labels`
- `gitea_replace_labels`
- `gitea_remove_label`

### Tags and releases

- `gitea_list_tags`
- `gitea_create_tag`
- `gitea_delete_tag`
- `gitea_list_releases`
- `gitea_create_release`

### Branches and issues

- `gitea_list_branches`
- `gitea_create_branch`
- `gitea_delete_branch`
- `gitea_list_issues`
- `gitea_create_issue`
- `gitea_update_issue`

### Repositories and files

- `gitea_get_repo`
- `gitea_get_file`

Most repository tools accept `owner` and `repo`. `repo` is required; `owner` defaults to `GITEA_OWNER` when configured.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Run the TypeScript server with file watching |
| `npm run build` | Compile `server.ts` to `dist/server.js` |
| `npm start` | Start the compiled server |

## Project Structure

- `server.ts` - MCP server setup, Gitea API helpers, and tool definitions
- `package.json` - dependencies and npm scripts
- `tsconfig.json` - TypeScript build configuration
- `dist/server.js` - generated production entrypoint
