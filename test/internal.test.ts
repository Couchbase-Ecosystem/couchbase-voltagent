import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../src/internal.js";

describe("mapWithConcurrency", () => {
  it("waits for in-flight workers before reporting a batch failure", async () => {
    let finishSecond: (() => void) | undefined;
    const secondFinished = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });
    let settled = false;

    const operation = mapWithConcurrency(["fail", "slow"], 2, async (value) => {
      if (value === "fail") {
        throw new Error("batch failure");
      }
      await secondFinished;
      return value;
    });
    void operation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    finishSecond?.();
    await expect(operation).rejects.toThrow("batch failure");
  });
});
