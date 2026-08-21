import { CouchbaseVectorAdapterConfigurationError } from "./errors.js";

export function quoteIdentifier(value: string): string {
  return `\`${value.replaceAll("`", "``")}\``;
}

export function quoteStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function validateIndexName(value: string): void {
  if (!/^[A-Za-z][A-Za-z0-9#_]*$/.test(value)) {
    throw new CouchbaseVectorAdapterConfigurationError(
      "indexName must start with a letter and contain only letters, digits, #, or _",
    );
  }
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value !== undefined) {
        results[index] = await mapper(value, index);
      }
    }
  }

  const workerCount = Math.min(concurrency, values.length);
  const settled = await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));
  const failure = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) {
    throw failure.reason;
  }
  return results;
}
