/**
 * Concurrency helpers shared across the `UsageReader` split modules.
 */

/** Max concurrent transcript reads / stats, to stay well under the fd limit. */
export const READ_CONCURRENCY = 16;

/**
 * Run `worker` over `items` with at most `limit` in flight, preserving order.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) {
          return;
        }
        results[index] = await worker(items[index]);
      }
    },
  );

  await Promise.all(runners);
  return results;
}
