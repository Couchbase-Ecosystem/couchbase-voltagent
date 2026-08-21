import {
  type BaseMessage,
  BaseRetriever,
  type RetrieveOptions,
  type RetrieverOptions,
  type VectorSearchOptions,
} from "@voltagent/core";
import type { CouchbaseVectorAdapter } from "./vector-adapter.js";

export interface CouchbaseRetrieverOptions extends RetrieverOptions {
  adapter: CouchbaseVectorAdapter;
  embed: (text: string) => Promise<number[]>;
  topK?: number;
  threshold?: number;
  /** Static or request-aware equality filters. */
  filter?:
    | Record<string, unknown>
    | ((options: RetrieveOptions) => Record<string, unknown> | undefined);
  /** Label stored in options.context references. Defaults to Couchbase. */
  sourceName?: string;
  /** Returned when no matching content exists. */
  emptyResultMessage?: string;
}

/** A ready-to-use VoltAgent retriever backed by CouchbaseVectorAdapter. */
export class CouchbaseRetriever extends BaseRetriever {
  private readonly adapter: CouchbaseVectorAdapter;
  private readonly embed: (text: string) => Promise<number[]>;
  private readonly topK: number;
  private readonly threshold: number | undefined;
  private readonly filter?: CouchbaseRetrieverOptions["filter"];
  private readonly sourceName: string;
  private readonly emptyResultMessage: string;

  constructor(options: CouchbaseRetrieverOptions) {
    super(options);
    this.adapter = options.adapter;
    this.embed = options.embed;
    this.topK = options.topK ?? 3;
    this.threshold = options.threshold;
    this.filter = options.filter;
    this.sourceName = options.sourceName ?? "Couchbase";
    this.emptyResultMessage =
      options.emptyResultMessage ?? "No relevant documents found in the knowledge base.";
  }

  override async retrieve(
    input: string | BaseMessage[],
    options: RetrieveOptions,
  ): Promise<string> {
    const text = extractSearchText(input);
    const vector = await this.embed(text);
    const filter = typeof this.filter === "function" ? this.filter(options) : this.filter;
    const searchOptions: VectorSearchOptions = {
      limit: this.topK,
      ...(this.threshold === undefined ? {} : { threshold: this.threshold }),
      ...(filter === undefined ? {} : { filter }),
    };
    const results = await this.adapter.search(vector, searchOptions);

    if (options.context && results.length > 0) {
      options.context.set(
        "references",
        results.map((result, index) => ({
          id: result.id,
          title:
            typeof result.metadata?.title === "string"
              ? result.metadata.title
              : `Document ${index + 1}`,
          source: this.sourceName,
          score: result.score,
          metadata: result.metadata,
        })),
      );
    }

    const withContent = results.filter(
      (result): result is typeof result & { content: string } =>
        typeof result.content === "string" && result.content.length > 0,
    );
    if (withContent.length === 0) {
      return this.emptyResultMessage;
    }
    return withContent
      .map(
        (result, index) =>
          `Document ${index + 1} (ID: ${result.id}, Score: ${result.score.toFixed(4)}):\n${result.content}`,
      )
      .join("\n\n---\n\n");
  }

  override getObservabilityAttributes(): Record<string, unknown> {
    return {
      "db.system": "couchbase",
      "db.namespace": `${this.adapter.bucketName}.${this.adapter.scopeName}.${this.adapter.collectionName}`,
      "retrieval.top_k": this.topK,
    };
  }
}

export function extractSearchText(input: string | BaseMessage[]): string {
  if (typeof input === "string") {
    return input;
  }
  const lastMessage = input.at(-1);
  if (!lastMessage) {
    return "";
  }
  if (typeof lastMessage.content === "string") {
    return lastMessage.content;
  }
  if (!Array.isArray(lastMessage.content)) {
    return "";
  }
  return lastMessage.content
    .flatMap((part) => {
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
        return [part.text];
      }
      return [];
    })
    .join(" ");
}
