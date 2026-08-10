/**
 * React binding for {@link createPoll}. Components share the module-level
 * poll instance; this hook only wires it into `useSyncExternalStore`.
 */

import { useSyncExternalStore } from "react";
import type { Poll, PollState } from "./poll";

export function usePoll<T>(poll: Poll<T>): PollState<T> {
  return useSyncExternalStore(
    poll.subscribe,
    poll.getSnapshot,
    poll.getSnapshot,
  );
}
