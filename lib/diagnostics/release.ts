/**
 * The commit of the running code, short form, or "unknown". Vercel sets VERCEL_GIT_COMMIT_SHA on each
 * deploy. Hosts outside Vercel (the scheduler VM, self-host) set EMULY_RELEASE when they copy the code.
 */
export function releaseId(): string {
  for (const value of [process.env.VERCEL_GIT_COMMIT_SHA, process.env.EMULY_RELEASE]) {
    if (value && /^[a-f0-9]{7,40}$/.test(value)) return value.slice(0, 7);
  }
  return "unknown";
}
