/** Explicit local names only; no DNS resolution or legacy numeric-IP aliases. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  if (['localhost', '::1', '[::1]'].includes(normalized)) return true;
  return /^127(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(normalized) && normalized.split('.').every((part) => Number(part) <= 255);
}
