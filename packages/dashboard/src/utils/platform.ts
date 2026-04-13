export const isMac = /mac/i.test(
  (navigator as Navigator & { userAgentData?: { platform: string } })
    .userAgentData?.platform ??
    navigator.platform ??
    "",
);

/** Whether Cmd (Mac) or Ctrl (other) is held — the platform's primary modifier. */
export function hasPrimaryModifier(event: {
  metaKey: boolean;
  ctrlKey: boolean;
}): boolean {
  return isMac ? event.metaKey : event.ctrlKey;
}
