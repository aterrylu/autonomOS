---
"@autonomos/server": patch
---

fix(security): the server's WebSockets refuse a message split into a flood of tiny fragments

The `ws` library before 8.21.1 kept every fragment of an unfinished message, with no limit, so one connection sending a stream of empty fragments could grow the server's memory until it crashed, taking every agent's terminal with it. `ws` is now 8.22.0, which closes such a connection (code 1008) after 16,384 fragments of one message. Normal traffic is unaffected: browsers send each message, including a large paste, as a single frame.
