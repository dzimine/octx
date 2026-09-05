#!/usr/bin/env node
/**
 * A minimal stdio MCP server used only to generate test fixtures.
 *
 * It exists so the context view's built-in / MCP / skill tool split can be verified against
 * real wire data rather than assumed: octx needs to see how opencode actually names and
 * serializes MCP tools. The three tools have deliberately different schema sizes so an
 * incorrect split is visible in the numbers.
 *
 * Not part of the shipped tool. Registered by tools/capture-fixture.sh, removed afterwards.
 */
const TOOLS = [
  {
    name: "ping",
    description: "Returns pong. Deliberately tiny so it anchors the small end of the range.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "echo",
    description: "Echoes a message back, optionally repeated. Mid-sized schema.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The text to echo back to the caller." },
        times: { type: "integer", description: "How many times to repeat it.", minimum: 1, maximum: 10 },
      },
      required: ["message"],
      additionalProperties: false,
    },
  },
  {
    name: "bloated_query",
    description:
      "A deliberately over-documented query tool. Its schema is padded so that it dominates " +
      "the MCP tool budget, which is what makes a mis-attributed split obvious in the report. " +
      "Real MCP servers routinely ship schemas this size, which is the whole reason the context " +
      "view separates MCP tools from built-in ones.",
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 12 }, (_, i) => [
          `filter_${i}`,
          {
            type: "string",
            description:
              `Filter expression number ${i}. Accepts a field name, an operator drawn from ` +
              `eq, ne, lt, lte, gt, gte, contains or startswith, and a literal value, joined ` +
              `by colons. Multiple filters are combined with a logical AND.`,
            examples: [`field_${i}:eq:value`, `field_${i}:contains:substring`],
          },
        ]),
      ),
      additionalProperties: false,
    },
  },
]

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n")
}

let buffer = ""
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let idx
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    handle(msg)
  }
})

function handle(msg) {
  const { id, method, params } = msg
  if (id === undefined) return // notification; nothing to answer

  if (method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id,
      result: {
        // Echo the client's version rather than pinning one, so this keeps working as the
        // protocol moves.
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "octx-fixture", version: "0.1.0" },
      },
    })
  }
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } })
  if (method === "tools/call") {
    const name = params?.name
    const text =
      name === "ping" ? "pong" : name === "echo" ? String(params?.arguments?.message ?? "") : "ok"
    return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } })
  }
  if (method === "resources/list") return send({ jsonrpc: "2.0", id, result: { resources: [] } })
  if (method === "prompts/list") return send({ jsonrpc: "2.0", id, result: { prompts: [] } })
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } })
}
