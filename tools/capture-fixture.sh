#!/usr/bin/env bash
# Regenerates test/fixtures/session.ndjson from a real opencode session.
#
# The fixture has to exercise everything the tests assert, so this temporarily registers a
# local MCP server (tools/mcp-fixture-server.mjs) in .opencode/opencode.json and removes it
# afterwards. Without MCP tools present, the built-in/MCP split has nothing to prove.
set -euo pipefail
cd "$(dirname "$0")/.."
repo="$PWD"

MODEL="${OCTX_FIXTURE_MODEL:-deepseek/deepseek-v4-flash}"
PROMPT='Use the octxfix ping tool, then tell me what it returned.'

level="$(node -e 'import("./lib/format.mjs").then(m=>console.log(m.resolveConfig().level))')"
if [ "$level" = "off" ]; then
  echo 'octx is off — set "level": "full" in ~/.config/opencode/octx.json first' >&2
  exit 1
fi
dir="$(node -e 'import("./lib/format.mjs").then(m=>console.log(m.resolveConfig().dir))')"

had_config=0
[ -f .opencode/opencode.json ] && had_config=1
cleanup() {
  if [ "$had_config" = "0" ]; then rm -f .opencode/opencode.json; rmdir .opencode 2>/dev/null || true; fi
}
trap cleanup EXIT

if [ "$had_config" = "0" ]; then
  mkdir -p .opencode
  cat > .opencode/opencode.json <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
  "mcp": {
    "octxfix": {
      "type": "local",
      "command": ["node", "$repo/tools/mcp-fixture-server.mjs"],
      "enabled": true
    }
  }
}
JSON
fi

echo "capturing with $MODEL into $dir"
opencode run "$PROMPT" --model "$MODEL" >/dev/null 2>&1 || true

newest="$(ls -1t "$dir"/*/*.ndjson 2>/dev/null | head -1)"
if [ -z "$newest" ]; then
  echo "no trace produced — is the plugin symlinked into ~/.config/opencode/plugin/?" >&2
  exit 1
fi

# Strip the raw request/response blobs: the tests work from the normalized records, and the
# literal SSE stream is most of the file size.
node -e '
const fs=require("fs")
const lines=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map(JSON.parse)
const drop=new Set(lines.filter(l=>l.t==="blob"&&(l.kind==="raw"||l.kind==="response")).map(l=>l.h))
const keep=[]
for(const l of lines){
  if(l.t==="blob"&&drop.has(l.h))continue
  if(l.t==="req")delete l.raw
  if(l.t==="res")delete l.body
  keep.push(l)
}
fs.writeFileSync("test/fixtures/session.ndjson", keep.map(l=>JSON.stringify(l)).join("\n")+"\n")
console.log("wrote test/fixtures/session.ndjson ("+keep.length+" records)")
' "$newest"

node --test "test/*.test.mjs"
