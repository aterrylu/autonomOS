export const isMac = /mac/i.test(
  (navigator as Navigator & { userAgentData?: { platform: string } })
    .userAgentData?.platform ??
    navigator.platform ??
    "",
);
