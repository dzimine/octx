# Regenerating the example page

`index.html` is a real octx report from an 11-call session, scrubbed of all content.

```sh
# 1. scrub a real trace — replaces content, keeps shape and measured token counts
node tools/scrub-trace.mjs ~/.local/share/octx/<date>/<session>.ndjson /tmp/clean.ndjson \
  --title "Analysing a large JSON dataset"

# 2. stage it in a trace dir of its own, so the CLI finds only that one
mkdir -p /tmp/demo/2026-01-01 && cp /tmp/clean.ndjson /tmp/demo/2026-01-01/ses_demo.ndjson

# 3. render it as the Pages root
node cli/octx.mjs report --dir /tmp/demo -o docs/index.html
```

Then verify before publishing. The scrubber being thorough is not the safeguard — the check is:

```sh
grep -c -E "$(whoami)|/Users/|@" docs/index.html    # expect 0
```

The model name and provider endpoint are kept on purpose: public facts, and without them the
report stops making sense.

**A trace is not safe to share unscrubbed.** It contains your prompts, the contents of every
file your tools read, and a system prompt that on opencode inlines your AGENTS.md.
