// Everything the server keeps, in one SQLite file in the data folder. Rows hold their object as
// JSON beside the columns used to find them, so a new field needs no migration.

import { DatabaseSync, type StatementSync } from "node:sqlite";

import type {
  BackgroundJob,
  ImageRef,
  Item,
  Project,
  ProviderId,
  QueuedMessage,
  Settings,
  Thread,
} from "@dodocode/protocol";

const SCHEMA = `
  create table if not exists projects (
    id text primary key,
    data text not null
  );
  create table if not exists threads (
    id text primary key,
    project_id text not null,
    parent_id text,
    data text not null,
    resume text not null default '{}',
    queue text not null default '[]',
    tasks text not null default '[]'
  );
  create index if not exists threads_project on threads (project_id);
  create index if not exists threads_parent on threads (parent_id);
  create table if not exists items (
    id text primary key,
    thread_id text not null,
    seq integer not null,
    data text not null
  );
  create index if not exists items_thread on items (thread_id, seq);
  create table if not exists attachments (
    id text primary key,
    data text not null,
    path text not null
  );
  create table if not exists kv (
    key text primary key,
    value text not null
  );
`;

export interface StoredAttachment extends ImageRef {
  path: string;
}

/** Where a provider's session picks up again. */
export interface ResumePoint {
  id: string;
  /** The running cost the session had reached, which its SDK carries on from on resume. */
  costUsd?: number;
}

export type ResumePoints = Partial<Record<ProviderId, ResumePoint>>;

export class Store {
  private db: DatabaseSync;
  private statements = new Map<string, StatementSync>();

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("pragma journal_mode = wal; pragma synchronous = normal;");
    this.db.exec(SCHEMA);
  }

  private sql(text: string): StatementSync {
    let statement = this.statements.get(text);
    if (!statement) {
      statement = this.db.prepare(text);
      this.statements.set(text, statement);
    }
    return statement;
  }

  transaction(run: () => void): void {
    this.db.exec("begin");
    try {
      run();
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  // Projects

  projects(): Project[] {
    const rows = this.sql("select data from projects").all() as { data: string }[];
    return rows
      .map((row) => JSON.parse(row.data) as Project)
      .toSorted((a, b) => a.createdAt - b.createdAt);
  }

  saveProject(project: Project): void {
    this.sql("insert or replace into projects (id, data) values (?, ?)").run(
      project.id,
      JSON.stringify(project),
    );
  }

  deleteProject(id: string): void {
    this.transaction(() => {
      const threads = this.sql("select id from threads where project_id = ?").all(id) as {
        id: string;
      }[];
      for (const thread of threads) this.deleteThreadRows(thread.id);
      this.sql("delete from projects where id = ?").run(id);
    });
  }

  // Threads

  threads(): Thread[] {
    const rows = this.sql("select data from threads").all() as { data: string }[];
    return rows.map((row) => JSON.parse(row.data) as Thread);
  }

  saveThread(thread: Thread): void {
    this.sql(
      `insert into threads (id, project_id, parent_id, data) values (?, ?, ?, ?)
       on conflict (id) do update set data = excluded.data`,
    ).run(thread.id, thread.projectId ?? "", thread.parentId ?? null, JSON.stringify(thread));
  }

  deleteThread(id: string): void {
    this.transaction(() => {
      // The thread, its subagents' threads, and theirs.
      const tree = this.sql(
        `with recursive tree(id) as (
           select ?
           union all
           select threads.id from threads join tree on threads.parent_id = tree.id
         )
         select id from tree`,
      ).all(id) as { id: string }[];
      for (const row of tree) this.deleteThreadRows(row.id);
    });
  }

  private deleteThreadRows(id: string): void {
    this.sql("delete from items where thread_id = ?").run(id);
    this.sql("delete from threads where id = ?").run(id);
  }

  resumePoints(threadId: string): ResumePoints {
    const row = this.sql("select resume from threads where id = ?").get(threadId) as
      | { resume: string }
      | undefined;
    if (!row) return {};
    const saved = JSON.parse(row.resume) as Record<string, ResumePoint | string>;
    const points: Record<string, ResumePoint> = {};
    // A thread saved before costs were kept holds only the session's id.
    for (const [provider, point] of Object.entries(saved)) {
      points[provider] = typeof point === "string" ? { id: point } : point;
    }
    return points as ResumePoints;
  }

  /** Every agent session a thread picks up, as `provider:id`. */
  resumedSessions(): Set<string> {
    const rows = this.sql("select resume from threads").all() as { resume: string }[];
    const sessions = new Set<string>();
    for (const row of rows) {
      const saved = JSON.parse(row.resume) as Record<string, ResumePoint | string>;
      for (const [provider, point] of Object.entries(saved)) {
        sessions.add(`${provider}:${typeof point === "string" ? point : point.id}`);
      }
    }
    return sessions;
  }

  saveResumePoints(threadId: string, points: ResumePoints): void {
    this.sql("update threads set resume = ? where id = ?").run(JSON.stringify(points), threadId);
  }

  queue(threadId: string): QueuedMessage[] {
    const row = this.sql("select queue from threads where id = ?").get(threadId) as
      | { queue: string }
      | undefined;
    return row ? (JSON.parse(row.queue) as QueuedMessage[]) : [];
  }

  saveQueue(threadId: string, queue: QueuedMessage[]): void {
    this.sql("update threads set queue = ? where id = ?").run(JSON.stringify(queue), threadId);
  }

  // Background jobs live in the `tasks` column, named before tasks meant work on the board.
  jobs(threadId: string): BackgroundJob[] {
    const row = this.sql("select tasks from threads where id = ?").get(threadId) as
      | { tasks: string }
      | undefined;
    return row ? (JSON.parse(row.tasks) as BackgroundJob[]) : [];
  }

  saveJobs(threadId: string, jobs: BackgroundJob[]): void {
    this.sql("update threads set tasks = ? where id = ?").run(JSON.stringify(jobs), threadId);
  }

  // Items

  items(threadId: string): Item[] {
    const rows = this.sql("select data from items where thread_id = ? order by seq").all(
      threadId,
    ) as { data: string }[];
    return rows.map((row) => JSON.parse(row.data) as Item);
  }

  lastSeq(threadId: string): number {
    const row = this.sql("select max(seq) as seq from items where thread_id = ?").get(threadId) as {
      seq: number | null;
    };
    return row.seq ?? 0;
  }

  saveItem(item: Item): void {
    this.sql(
      `insert into items (id, thread_id, seq, data) values (?, ?, ?, ?)
       on conflict (id) do update set data = excluded.data`,
    ).run(item.id, item.threadId, item.seq, JSON.stringify(item));
  }

  // Attachments

  attachment(id: string): StoredAttachment | undefined {
    const row = this.sql("select data, path from attachments where id = ?").get(id) as
      | { data: string; path: string }
      | undefined;
    return row ? { ...(JSON.parse(row.data) as ImageRef), path: row.path } : undefined;
  }

  saveAttachment(attachment: StoredAttachment): void {
    const { path, ...ref } = attachment;
    this.sql("insert or replace into attachments (id, data, path) values (?, ?, ?)").run(
      ref.id,
      JSON.stringify(ref),
      path,
    );
  }

  // Settings

  settings(): Settings | undefined {
    const row = this.sql("select value from kv where key = 'settings'").get() as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as Settings) : undefined;
  }

  saveSettings(settings: Settings): void {
    this.sql("insert or replace into kv (key, value) values ('settings', ?)").run(
      JSON.stringify(settings),
    );
  }
}
