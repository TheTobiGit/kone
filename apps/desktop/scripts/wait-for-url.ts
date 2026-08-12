export async function waitForUrl(
  url: string,
  { timeoutMs = 120_000, intervalMs = 500 }: { timeoutMs?: number; intervalMs?: number } = {},
) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) return;
    } catch {
    }

    await Bun.sleep(intervalMs);
  }

  throw new Error(`Timed out waiting for ${url}`);
}
