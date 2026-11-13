// How server data reaches a TanStack DB collection. A feed loads a snapshot from the server and
// then applies the events that follow it. Collections attach to a feed while something reads
// them, and the feed writes into each one through a RowWriter.

import type { SyncConfig } from "@tanstack/react-db";
import type { ServerEvent } from "@dodocode/protocol";
import { startShownSpan } from "../perf";
import { Disconnected, server } from "./connection";

type SyncParams<T extends object, K extends string | number> = Parameters<
  SyncConfig<T, K>["sync"]
>[0];

/**
 * Writes server rows into a collection's synced state. It keeps the rows it wrote, because the
 * collection refuses an insert for a key it holds and an update for one it does not.
 */
export class RowWriter<T extends object, K extends string | number> {
  private held = new Map<K, T>();

  constructor(
    private params: SyncParams<T, K>,
    private getKey: (row: T) => K,
  ) {}

  /** The rows as the server last sent them. */
  get rows(): ReadonlyMap<K, T> {
    return this.held;
  }

  /** Replaces every row with these. */
  replace(rows: Iterable<T>): void {
    const { begin, write, commit } = this.params;
    begin({ snapshot: true });
    this.held.clear();
    for (const row of rows) {
      write({ type: "insert", value: row });
      this.held.set(this.getKey(row), row);
    }
    commit();
  }

  /** Writes these rows whole, adding the ones that are new. */
  upsert(rows: Iterable<T>): void {
    const { begin, write, commit } = this.params;
    begin();
    for (const row of rows) {
      const key = this.getKey(row);
      write({ type: this.held.has(key) ? "update" : "insert", value: row });
      this.held.set(key, row);
    }
    commit();
  }

  remove(key: K): void {
    if (!this.held.has(key)) return;
    const { begin, write, commit } = this.params;
    begin();
    write({ type: "delete", key });
    this.held.delete(key);
    commit();
  }
}

export interface FeedSink<S> {
  load(snapshot: S): void;
  fail(error: unknown): void;
}

export interface FeedOptions<S> {
  /** Names the feed's `feed:` span in a performance trace: see perf.ts. */
  name: string;
  /** Asks the server for everything the feed covers. */
  load(): Promise<S>;
  /** Applies an event that came after the snapshot. */
  apply(event: ServerEvent): void;
  /** Runs before a new snapshot lands: drops events the snapshot already holds. */
  reset?(): void;
  /** Runs each time a snapshot has landed in the sinks. */
  loaded?(): void;
  /** Runs when the last sink leaves. */
  release?(): void;
  /** True to try a failed load again after a pause; false to report it to the sinks. */
  retry?: boolean;
}

const RETRY_MS = 2000;

/**
 * A snapshot and the events after it, shared by the collections that show one part of the server.
 * Each time the socket opens it loads a new snapshot: events that came while it waited are in the
 * snapshot already (see connection.ts), so the feed applies only the events after the answer.
 */
export class Feed<S> {
  private sinks = new Set<FeedSink<S>>();
  /** True once a snapshot has landed on this socket: events then apply. */
  private live = false;
  /** Counts loads, so an answer to an older one is dropped. */
  private generation = 0;
  private stop: (() => void) | undefined;

  constructor(private options: FeedOptions<S>) {}

  attach(sink: FeedSink<S>): () => void {
    this.sinks.add(sink);
    if (!this.stop) {
      const offEvent = server.onEvent((event) => {
        if (this.live) this.options.apply(event);
      });
      const offOpen = server.whenOpen(() => this.load());
      this.stop = () => {
        offEvent();
        offOpen();
      };
    } else if (this.live) {
      // A load in flight covers the new sink; once live, only a new snapshot gives it the rows.
      this.load();
    }
    return () => {
      if (!this.sinks.delete(sink) || this.sinks.size > 0) return;
      this.stop?.();
      this.stop = undefined;
      this.live = false;
      this.generation += 1;
      this.options.release?.();
    };
  }

  private load(): void {
    const generation = ++this.generation;
    this.live = false;
    const end = startShownSpan(`feed:${this.options.name}`);
    this.options.load().then(
      (snapshot) => {
        if (generation !== this.generation) return;
        this.live = true;
        this.options.reset?.();
        for (const sink of Array.from(this.sinks)) sink.load(snapshot);
        end();
        this.options.loaded?.();
      },
      (error: unknown) => {
        if (generation !== this.generation) return;
        // The next socket loads again.
        if (error instanceof Disconnected) return;
        if (this.options.retry) {
          console.error("Could not load from the server; trying again.", error);
          window.setTimeout(() => {
            if (generation === this.generation && this.stop) this.load();
          }, RETRY_MS);
          return;
        }
        for (const sink of Array.from(this.sinks)) sink.fail(error);
      },
    );
  }
}

/**
 * A collection's sync that takes its rows from a feed. `pick` chooses the collection's rows from
 * a snapshot; `bind` hands the writer to whatever applies the feed's events.
 */
export function feedSync<T extends object, K extends string | number, S>(
  feed: Feed<S>,
  getKey: (row: T) => K,
  pick: (snapshot: S) => Iterable<T>,
  bind: (writer: RowWriter<T, K> | undefined) => void,
): SyncConfig<T, K> {
  return {
    rowUpdateMode: "full",
    sync: (params) => {
      const writer = new RowWriter(params, getKey);
      bind(writer);
      const detach = feed.attach({
        load: (snapshot) => {
          writer.replace(pick(snapshot));
          params.markReady();
        },
        fail: (error) => params.fail(error),
      });
      return () => {
        detach();
        bind(undefined);
      };
    },
  };
}
