/**
 * Phase 12.2 R1(b) — correct save/restore of an env var around a test that
 * temporarily changes it. `process.env.X = saved` when `saved` is `undefined`
 * assigns the STRING "undefined" (a real, truthy value), which silently breaks
 * later tests and masks the "key is absent" case. Always restore with this.
 */
export function restoreEnv(key: string, saved: string | undefined): void {
  if (saved === undefined) delete process.env[key];
  else process.env[key] = saved;
}
