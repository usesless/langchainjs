import * as uuid from "uuid";
import type {
  WeaviateObject,
  WeaviateClient,
  WhereFilter,
} from "weaviate-ts-client";
import { VectorStore } from "./base.js";
import { Embeddings } from "../embeddings/base.js";
import { Document } from "../document.js";

// Note this function is not generic, it is designed specifically for Weaviate
// https://weaviate.io/developers/weaviate/config-refs/datatypes#introduction
export const flattenObjectForWeaviate = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  obj: Record<string, any>
) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const flattenedObject: Record<string, any> = {};

  for (const key in obj) {
    if (!Object.hasOwn(obj, key)) {
      continue;
    }
    const value = obj[key];
    if (typeof obj[key] === "object" && !Array.isArray(value)) {
      const recursiveResult = flattenObjectForWeaviate(value);

      for (const deepKey in recursiveResult) {
        if (Object.hasOwn(obj, key)) {
          flattenedObject[`${key}_${deepKey}`] = recursiveResult[deepKey];
        }
      }
    } else if (Array.isArray(value)) {
      if (
        value.length > 0 &&
        typeof value[0] !== "object" &&
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        value.every((el: any) => typeof el === typeof value[0])
      ) {
        // Weaviate only supports arrays of primitive types,
        // where all elements are of the same type
        flattenedObject[key] = value;
      }
    } else {
      flattenedObject[key] = value;
    }
  }

  return flattenedObject;
};

export interface WeaviateLibArgs {
  client: WeaviateClient;
  /**
   * The name of the class in Weaviate. Must start with a capital letter.
   */
  indexName: string;
  textKey?: string;
  metadataKeys?: string[];
}

interface ResultRow {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface WeaviateFilter {
  distance?: number;
  where: WhereFilter;
}

export class WeaviateStore extends VectorStore {
  declare FilterType: WeaviateFilter;

  private client: WeaviateClient;

  private indexName: string;

  private textKey: string;

  private queryAttrs: string[];

  _vectorstoreType(): string {
    return "weaviate";
  }

  constructor(public embeddings: Embeddings, args: WeaviateLibArgs) {
    super(embeddings, args);

    this.client = args.client;
    this.indexName = args.indexName;
    this.textKey = args.textKey || "text";
    this.queryAttrs = [this.textKey];

    if (args.metadataKeys) {
      this.queryAttrs = [
        ...new Set([
          ...this.queryAttrs,
          ...args.metadataKeys.filter((k) => {
            // https://spec.graphql.org/June2018/#sec-Names
            // queryAttrs need to be valid GraphQL Names
            const keyIsValid = /^[_A-Za-z][_0-9A-Za-z]*$/.test(k);
            if (!keyIsValid) {
              console.warn(
                `Skipping metadata key ${k} as it is not a valid GraphQL Name`
              );
            }
            return keyIsValid;
          }),
        ]),
      ];
    }
  }

  async addVectors(
    vectors: number[][],
    documents: Document[],
    options?: { ids?: string[] }
  ) {
    const documentIds = options?.ids ?? documents.map((_) => uuid.v4());
    const batch: WeaviateObject[] = documents.map((document, index) => {
      if (Object.hasOwn(document.metadata, "id"))
        throw new Error(
          "Document inserted to Weaviate vectorstore should not have `id` in their metadata."
        );

      const flattenedMetadata = flattenObjectForWeaviate(document.metadata);
      return {
        class: this.indexName,
        id: documentIds[index],
        vector: vectors[index],
        properties: {
          [this.textKey]: document.pageContent,
          ...flattenedMetadata,
        },
      };
    });

    try {
      await this.client.batch
        .objectsBatcher()
        .withObjects(...batch)
        .do();
    } catch (e) {
      throw Error(`'Error adding vectors' ${e}`);
    }
    return documentIds;
  }

  async addDocuments(documents: Document[], options?: { ids?: string[] }) {
    return this.addVectors(
      await this.embeddings.embedDocuments(documents.map((d) => d.pageContent)),
      documents,
      options
    );
  }

  async delete(params: {
    ids?: string[];
    filter?: WeaviateFilter;
  }): Promise<void> {
    const { ids, filter } = params;

    if (ids && ids.length > 0) {
      for (const id of ids) {
        await this.client.data
          .deleter()
          .withClassName(this.indexName)
          .withId(id)
          .do();
      }
    } else if (filter) {
      await this.client.batch
        .objectsBatchDeleter()
        .withClassName(this.indexName)
        .withWhere(filter.where)
        .do();
    } else {
      throw new Error(
        `This method requires either "ids" or "filter" to be set in the input object`
      );
    }
  }

  async similaritySearchVectorWithScore(
    query: number[],
    k: number,
    filter?: WeaviateFilter
  ): Promise<[Document, number][]> {
    try {
      let builder = await this.client.graphql
        .get()
        .withClassName(this.indexName)
        .withFields(`${this.queryAttrs.join(" ")} _additional { distance }`)
        .withNearVector({
          vector: query,
          distance: filter?.distance,
        })
        .withLimit(k);

      if (filter?.where) {
        builder = builder.withWhere(filter.where);
      }

      const result = await builder.do();

      const documents: [Document, number][] = [];
      for (const data of result.data.Get[this.indexName]) {
        const { [this.textKey]: text, _additional, ...rest }: ResultRow = data;

        documents.push([
          new Document({
            pageContent: text,
            metadata: rest,
          }),
          _additional.distance,
        ]);
      }
      return documents;
    } catch (e) {
      throw Error(`'Error in similaritySearch' ${e}`);
    }
  }

  static fromTexts(
    texts: string[],
    metadatas: object | object[],
    embeddings: Embeddings,
    args: WeaviateLibArgs
  ): Promise<WeaviateStore> {
    const docs: Document[] = [];
    for (let i = 0; i < texts.length; i += 1) {
      const metadata = Array.isArray(metadatas) ? metadatas[i] : metadatas;
      const newDoc = new Document({
        pageContent: texts[i],
        metadata,
      });
      docs.push(newDoc);
    }
    return WeaviateStore.fromDocuments(docs, embeddings, args);
  }

  static async fromDocuments(
    docs: Document[],
    embeddings: Embeddings,
    args: WeaviateLibArgs
  ): Promise<WeaviateStore> {
    const instance = new this(embeddings, args);
    await instance.addDocuments(docs);
    return instance;
  }

  static async fromExistingIndex(
    embeddings: Embeddings,
    args: WeaviateLibArgs
  ): Promise<WeaviateStore> {
    return new this(embeddings, args);
  }
}
