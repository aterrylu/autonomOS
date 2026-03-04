# OpenClaw

**Type:** Integration target — current agent runtime
**Repo:** https://github.com/openclaw/openclaw
**Docs:** https://docs.openclaw.ai

## What It Is
Agent orchestration platform. Handles agent config, cron jobs, sessions, memory, multi-channel routing (Discord, Telegram, etc.).

## Why We Care
This is our starting substrate. autonomOS sits above OpenClaw as a control plane. Need to understand:
- Session model and lifecycle
- Cron/automation system
- Memory layer (MEMORY.md, daily files)
- Agent configuration format
- API/CLI surface for reading state

## To Investigate
- [ ] Internal architecture — how are sessions managed?
- [ ] What data is exposed via API/CLI?
- [ ] How does the cron system work internally?
- [ ] Memory model — how is state persisted?
- [ ] Plugin/channel architecture
- [ ] Can we read OpenClaw state without modifying it? (observability first)
