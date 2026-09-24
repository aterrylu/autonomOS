/**
 * Cross-component signal for the update flow. The flow itself (state
 * machine + modal + reconnect overlay) is owned by the always-mounted
 * status-bar item; the Settings → Updates section and the post-update
 * banner live elsewhere in the tree and ask it to open the Restore
 * confirmation through this nonce.
 */

import { create } from "zustand";

interface UpdateBus {
  /** Bumped per request; the flow owner reacts to changes, not values. */
  restoreNonce: number;
  requestRestore: () => void;
  /** Bumped when the server says `latest` moved (VERSION_CHANGED): the pill
   *  refetches /api/system/version so the dialog shows — and asks for — the
   *  version it will actually install. */
  versionNonce: number;
  refreshVersion: () => void;
}

export const useUpdateBus = create<UpdateBus>((set) => ({
  restoreNonce: 0,
  requestRestore: () => set((s) => ({ restoreNonce: s.restoreNonce + 1 })),
  versionNonce: 0,
  refreshVersion: () => set((s) => ({ versionNonce: s.versionNonce + 1 })),
}));
