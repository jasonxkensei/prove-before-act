import { type Express } from "express";
import { logger } from "../logger";
import { paymentRateLimiter } from "../reliability";
import { createMcpServer, authenticateApiKey } from "../mcp";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getClientIp } from "../routes/helpers";
import { CANONICAL_PUBLIC_ORIGIN } from "../publicOrigin";

export function registerMcpRoutesRoutes(app: Express) {
  app.post("/mcp", paymentRateLimiter, async (req, res) => {
    try {
      const auth = await authenticateApiKey(req.headers.authorization);
      const baseUrl = CANONICAL_PUBLIC_ORIGIN;

      const method = req.body?.method;
      const toolName = req.body?.params?.name;

      // register_free_trial has been renamed to register_trial.
      // Return a clear migration message so existing integrations self-heal.
      if (method === "tools/call" && toolName === "register_free_trial") {
        return res.status(200).json({
          jsonrpc: "2.0",
          id: req.body?.id ?? null,
          result: {
            content: [{ type: "text", text: JSON.stringify({ error: "TOOL_RENAMED", message: "register_free_trial has been renamed to register_trial. Call register_trial with {agent_name: 'your-bot'} to get 10 free certifications instantly." }) }],
            isError: true,
          },
        });
      }

      // Block write tools at transport level when the caller is not authenticated.
      // Each tool also performs an internal auth check, but this early return
      // prevents the MCP server from even initialising for unauthenticated write calls.
      const WRITE_TOOLS = new Set(["certify_file", "certify_with_confidence", "audit_agent_session"]);
      if (method === "tools/call" && WRITE_TOOLS.has(toolName) && !auth.valid) {
        return res.status(200).json({
          jsonrpc: "2.0",
          id: req.body?.id || null,
          result: {
            content: [{ type: "text", text: JSON.stringify({ error: "UNAUTHORIZED", message: "No API key? Call register_trial with {agent_name: 'your-bot'} to get 10 free certifications instantly — no wallet, no credit card. Or include Authorization: Bearer pm_YOUR_KEY header." }) }],
            isError: true,
          },
        });
      }

      const xPaymentHeader = req.headers["x-payment"] as string | undefined;
      const host = req.get('host') || '';
      const clientIp = getClientIp(req);
      const mcpServer = await createMcpServer({ baseUrl, auth, xPaymentHeader, host, clientIp });

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      res.on("close", () => {
        transport.close();
      });

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.withRequest(req).error("MCP error");
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", (_req, res) => {
    const canonicalUrl = `${CANONICAL_PUBLIC_ORIGIN}/mcp`;
    res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Prove Before Act MCP server</title>
<meta name="description" content="Connect an AI agent to Prove Before Act with the Model Context Protocol.">
<link rel="canonical" href="${canonicalUrl}">
<style>body{margin:0;font:16px/1.6 system-ui,sans-serif;color:#172033;background:#f8fafc}main{max-width:780px;margin:0 auto;padding:72px 24px}code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}pre{overflow:auto;padding:18px;border-radius:10px;background:#111827;color:#e5e7eb}a{color:#146c43}h1{font-size:clamp(2rem,6vw,3.5rem);line-height:1.1}p{max-width:68ch}.eyebrow{font-weight:700;color:#146c43;text-transform:uppercase;letter-spacing:.08em}</style>
</head><body><main>
<p class="eyebrow">Model Context Protocol</p>
<h1>Prove Before Act for AI agents</h1>
<p>Use this MCP endpoint to anchor agent decisions, outputs, and audit events before an action is taken. The protocol transport is JSON-RPC over Streamable HTTP.</p>
<h2>Connect</h2>
<pre>{
  "mcpServers": {
    "prove-before-act": {
      "url": "${canonicalUrl}",
      "headers": { "Authorization": "Bearer pm_YOUR_API_KEY" }
    }
  }
}</pre>
<p>Send MCP JSON-RPC requests with <code>POST ${canonicalUrl}</code>. This page is intentionally served on GET for people, crawlers, and agent discovery; it does not replace the transport endpoint.</p>
<h2>Start without an API key</h2>
<p>Call the <code>register_trial</code> MCP tool to create a trial key with free proof credits, or use x402 for pay-per-call certification.</p>
<p><a href="/agents">Agent integrations</a> · <a href="/docs">REST API documentation</a> · <a href="/llms-full.txt">LLM-readable documentation</a></p>
</main></body></html>`);
  });

  app.delete("/mcp", (_req, res) => {
    res.status(204).end();
  });
}
