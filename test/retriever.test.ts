import type { BaseMessage, SearchResult } from "@voltagent/core";
import { describe, expect, it, vi } from "vitest";
import { CouchbaseRetriever, extractSearchText } from "../src/retriever.js";
import type { CouchbaseVectorAdapter } from "../src/vector-adapter.js";

function fakeAdapter(results: SearchResult[]) {
  return {
    bucketName: "app",
    scopeName: "ai",
    collectionName: "vectors",
    search: vi.fn().mockResolvedValue(results),
  } as unknown as CouchbaseVectorAdapter;
}

describe("CouchbaseRetriever", () => {
  it("embeds input, searches, formats context, and records references", async () => {
    const adapter = fakeAdapter([
      {
        id: "doc-1",
        vector: [1, 0],
        content: "Couchbase supports vector search.",
        metadata: { title: "Vector Search" },
        score: 0.95,
        distance: 0.1,
      },
    ]);
    const embed = vi.fn().mockResolvedValue([1, 0]);
    const retriever = new CouchbaseRetriever({
      adapter,
      embed,
      topK: 4,
      threshold: 0.7,
      filter: (options) => ({ userId: options.userId ?? "public" }),
    });
    const context = new Map<string | symbol, unknown>();

    const output = await retriever.retrieve("What is vector search?", {
      userId: "u1",
      context,
    });

    expect(embed).toHaveBeenCalledWith("What is vector search?");
    expect(adapter.search).toHaveBeenCalledWith([1, 0], {
      limit: 4,
      threshold: 0.7,
      filter: { userId: "u1" },
    });
    expect(output).toContain("Couchbase supports vector search.");
    expect(context.get("references")).toEqual([
      expect.objectContaining({
        id: "doc-1",
        title: "Vector Search",
        source: "Couchbase",
        score: 0.95,
      }),
    ]);
    expect(retriever.getObservabilityAttributes()).toMatchObject({
      "db.system": "couchbase",
      "retrieval.top_k": 4,
    });
  });

  it("returns the configured empty response when results lack content", async () => {
    const adapter = fakeAdapter([{ id: "doc-1", vector: [1, 0], score: 0.8 }]);
    const retriever = new CouchbaseRetriever({
      adapter,
      embed: async () => [1, 0],
      emptyResultMessage: "Nothing found.",
    });
    await expect(retriever.retrieve("query", {})).resolves.toBe("Nothing found.");
  });
});

describe("extractSearchText", () => {
  it("supports strings, empty messages, string content, and text parts", () => {
    expect(extractSearchText("query")).toBe("query");
    expect(extractSearchText([])).toBe("");
    expect(extractSearchText([{ role: "user", content: "hello" } as unknown as BaseMessage])).toBe(
      "hello",
    );
    expect(
      extractSearchText([
        {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            { type: "image", image: "ignored" },
            { type: "text", text: "world" },
          ],
        } as unknown as BaseMessage,
      ]),
    ).toBe("hello world");
  });
});
