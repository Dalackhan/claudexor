import {
  readRunObservations,
  type CommandBackend,
  type EngineStore,
  type createSqlDaemonServices,
} from "@claudexor/daemon";
import { readTaskGroupRuns } from "@claudexor/control-api";
import type { TaskGroupRunsInput } from "@claudexor/schema";

type ControlReadGraph = Pick<
  ReturnType<typeof createSqlDaemonServices>,
  "commands" | "interactions" | "terminalFiles"
>;

/** Lazy read composition follows the attached graph through recovery. No identity
 * is synthesized when the durable engine store is absent or closed. */
export function sqlControlReadSources(
  current: () => ControlReadGraph,
  storeId: () => string | undefined,
) {
  return {
    taskGroupRuns: (input: TaskGroupRunsInput, signal?: AbortSignal) => {
      let selected: { graph: ControlReadGraph; storeId: string } | undefined;
      return readTaskGroupRuns(
        input,
        {
          storeId,
          page: (query) => {
            const graph = current();
            const queries = graph.commands.queries;
            if (!queries.taskGroupPage)
              throw Object.assign(new Error("indexed task group observation is unavailable"), {
                code: "task_group_runs_unavailable",
                status: 503,
                retryable: false,
              });
            selected = { graph, storeId: query.storeId };
            return queries.taskGroupPage(query);
          },
          snapshot: (ids, readSignal) => {
            if (!selected)
              throw Object.assign(new Error("task group page has not selected a store"), {
                code: "task_group_runs_unavailable",
                status: 503,
                retryable: false,
              });
            return readRunObservations(
              selected.graph.commands.queries,
              selected.graph.interactions,
              selected.storeId,
              ids,
              readSignal,
            );
          },
        },
        signal,
      );
    },
    runObservations: async (ids: readonly string[], signal?: AbortSignal) => {
      const identity = storeId();
      if (!identity)
        throw Object.assign(
          new Error("durable store identity is unavailable for run observation"),
          {
            code: "run_observation_unavailable",
            status: 503,
            retryable: false,
          },
        );
      const graph = current();
      return readRunObservations(graph.commands.queries, graph.interactions, identity, ids, signal);
    },
    terminalFilesPending: (id: string) => current().terminalFiles.pending(id),
  };
}

/** Storage is attached after import; callers keep the same command boundary.
 * Recovery admission refuses product calls before any of these dereference SQL. */
export function deferredCommands(current: () => CommandBackend): CommandBackend {
  return {
    current: () => current().current!(),
    forRequest: (params) => current().forRequest!(params),
    findById: (id) => current().findById!(id),
    pruneHistory: (...args) => current().pruneHistory(...args),
    queries: {
      observationRecords: (ids) => current().queries.observationRecords!(ids),
      taskGroupPage: (input) => {
        const queries = current().queries;
        if (!queries.taskGroupPage)
          throw Object.assign(new Error("indexed task group observation is unavailable"), {
            code: "task_group_runs_unavailable",
            status: 503,
            retryable: false,
          });
        return queries.taskGroupPage(input);
      },
      getByRunId: (id) => current().queries.getByRunId(id),
      select: (query) => current().queries.select(query),
      publicList: (query) => current().queries.publicList(query),
      active: () => current().queries.active(),
      count: () => current().queries.count(),
    },
  };
}

/** Startup and retention consume metadata, never command body blobs. */
export function sqlStartupRoots(store: EngineStore) {
  const roots = (query: string) =>
    (store.prepare(query).all() as Array<{ root: string }>).map((row) => row.root);
  return {
    projects: () =>
      roots(
        "SELECT scope_root AS root FROM command WHERE live=1 AND scope_root IS NOT NULL UNION SELECT root FROM pruned_root",
      ),
    execution: () =>
      roots(`SELECT DISTINCT json_extract(CAST(summary AS TEXT),'$.params.execution.workspaceRoot') AS root
      FROM command WHERE live=1 AND json_type(CAST(summary AS TEXT),'$.params.execution.workspaceRoot')='text'`),
  };
}
export function sqlActivityRecords(store: EngineStore) {
  return (
    store
      .prepare(
        `SELECT run_id AS runId,state,finished_at AS finishedAt,scope_root AS root,thread_id AS threadId
    FROM command WHERE live=1 AND kind='product'`,
      )
      .all() as Array<{
      runId: string | null;
      state: string;
      finishedAt: string | null;
      root: string | null;
      threadId: string | null;
    }>
  ).map((row) => ({
    runId: row.runId ?? undefined,
    state: row.state,
    finishedAt: row.finishedAt ?? undefined,
    params: {
      scope: row.root ? { kind: "project", root: row.root } : { kind: "global" },
      threadId: row.threadId ?? undefined,
    },
  }));
}
