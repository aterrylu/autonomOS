---
"@autonomos/server": minor
"@autonomos/dashboard": minor
---

Refine the usage-queue control into an at-limit toggle, and add a timed simulation mode for demos. The button now appears only when you're at the usage cap (driven by a new `capped` field on the `/api/usage-queue` status, computed fresh from usage independent of arming) and renders as a clear on/off switch — yellow border when off, green when on — with intent copy ("Auto-Enter when limit resets" / "Type in the terminal to queue"). The dev `/_simulate` endpoint gains `resetInSec`, which caps now and auto-clears after N seconds so you can arm a pane and watch the auto-Enter fire on its own (covered by a real-spawn integration test).
