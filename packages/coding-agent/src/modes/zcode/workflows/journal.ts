import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
	ActorRecord,
	ArtifactVersionRecord,
	Caps,
	GetNodeOptions,
	JournalStorePort,
	ListActorsOptions,
	ListEventsOptions,
	ListNodesOptions,
	NodeKind,
	NodeRecord,
	RunEvent,
	RunRecord,
	RunSettlementRecord,
	RunStatus,
	StoredEvent,
} from "./vendor/dynamic-workflow/index.js";

type RunRow = RunRecord & { createdAt: number; updatedAt: number; cursor: number };
type JsonRow = {
	data: string;
	result?: string | null;
	persona?: string | null;
	created?: number | null;
	updated?: number | null;
};
export type JournalNodeRecord = NodeRecord & { createdAt?: number; updatedAt?: number };
export type WorkspaceNodeRecord = NodeRecord & {
	createdAt: number;
	updatedAt: number;
	resultBytes?: number;
	resultCount?: number;
	exitCode?: number;
	stdoutBytes?: number;
	stderrBytes?: number;
};
const json = (value: unknown): string | null => (value === undefined ? null : JSON.stringify(value));
const decode = <T>(row: JsonRow): T => JSON.parse(row.data) as T;
function boundedLimit(limit: number | undefined): number {
	if (limit === undefined) return -1;
	if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid journal limit");
	return limit;
}

/** Dedicated native-profile workflow state. Conversation storage remains owned by AgentSession. */
export class OmpWorkflowJournal implements JournalStorePort {
	readonly path: string;
	readonly #db: Database;
	constructor(agentDir: string) {
		const dir = join(agentDir, "zcode");
		mkdirSync(dir, { recursive: true });
		this.path = join(dir, "workflows.sqlite");
		this.#db = new Database(this.path, { create: true, strict: true });
		this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS workflow_run (id TEXT PRIMARY KEY, cwd TEXT, name TEXT, parent TEXT, status TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, data TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS workflow_run_cwd ON workflow_run(cwd,created DESC);
   CREATE INDEX IF NOT EXISTS workflow_run_name ON workflow_run(name,created DESC);
   CREATE INDEX IF NOT EXISTS workflow_run_parent ON workflow_run(parent,created DESC);
   CREATE TABLE IF NOT EXISTS workflow_actor (id INTEGER PRIMARY KEY, run TEXT NOT NULL REFERENCES workflow_run(id), site TEXT NOT NULL, ordinal INTEGER NOT NULL, name TEXT, data TEXT NOT NULL, persona TEXT, UNIQUE(run,site,ordinal));
   CREATE TABLE IF NOT EXISTS workflow_node (id INTEGER PRIMARY KEY, run TEXT NOT NULL REFERENCES workflow_run(id), site TEXT NOT NULL, ordinal INTEGER NOT NULL, kind TEXT NOT NULL, artifact TEXT, data TEXT NOT NULL, result TEXT, created INTEGER, updated INTEGER, UNIQUE(run,site,ordinal));
   CREATE INDEX IF NOT EXISTS workflow_node_kind ON workflow_node(run,kind,id);
   CREATE INDEX IF NOT EXISTS workflow_node_artifact ON workflow_node(run,artifact,id);
   CREATE UNIQUE INDEX IF NOT EXISTS workflow_node_actor_seq ON workflow_node(run,json_extract(data,'$.actorSiteId'),json_extract(data,'$.actorOrdinal'),json_extract(data,'$.actorSeq')) WHERE kind='ask';
   CREATE TABLE IF NOT EXISTS workflow_event (sequence INTEGER PRIMARY KEY AUTOINCREMENT, run TEXT NOT NULL REFERENCES workflow_run(id), type TEXT NOT NULL, created INTEGER NOT NULL, data TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS workflow_event_run ON workflow_event(run,sequence);
   CREATE INDEX IF NOT EXISTS workflow_event_type ON workflow_event(run,type,sequence);`);
		const columns = this.#db.query<{ name: string }, []>(`PRAGMA table_info(workflow_node)`).all();
		for (const column of ["created", "updated"])
			if (!columns.some(existing => existing.name === column))
				this.#db.exec(`ALTER TABLE workflow_node ADD COLUMN ${column} INTEGER`);
	}
	transaction<T>(operation: () => T): T {
		return this.#db.transaction(operation).immediate();
	}
	close(): void {
		this.#db.close();
	}
	createRun(record: RunRecord): void {
		const now = Date.now();
		this.#db
			.query("INSERT INTO workflow_run(id,cwd,name,parent,status,created,updated,data) VALUES(?,?,?,?,?,?,?,?)")
			.run(
				record.runId,
				record.cwd ?? null,
				record.name ?? null,
				record.parentSessionId ?? null,
				record.status,
				now,
				now,
				JSON.stringify(record),
			);
	}
	getRun(runId: string): RunRecord | undefined {
		const row = this.#db.query<JsonRow, string[]>("SELECT data FROM workflow_run WHERE id=?").get(runId);
		return row ? decode<RunRecord>(row) : undefined;
	}
	#update(runId: string, change: (record: RunRecord) => void): void {
		this.transaction(() => {
			const record = this.getRun(runId);
			if (!record) throw new Error(`Workflow run not found: ${runId}`);
			change(record);
			this.#db
				.query("UPDATE workflow_run SET status=?, updated=?, data=? WHERE id=?")
				.run(record.status, Date.now(), JSON.stringify(record), runId);
		});
	}
	updateRunStatus(runId: string, status: RunStatus, settlement?: RunSettlementRecord): void {
		this.#update(runId, record => {
			record.status = status;
			delete record.failure;
			delete record.stopReason;
			delete record.supersededBy;
			if (status === "pending" || status === "running") {
				delete record.result;
				return;
			}
			if (status === "stopped") {
				record.stopReason = settlement?.stopReason ?? "user";
				if (settlement?.supersededBy !== undefined) record.supersededBy = settlement.supersededBy;
			}
			if ((status === "errored" || status === "stopped") && settlement?.failure !== undefined)
				record.failure = settlement.failure;
			if (settlement?.result !== undefined) record.result = settlement.result;
		});
	}
	updateRunUsage(runId: string, spentTokens: number): void {
		this.#update(runId, record => {
			record.spentTokens = spentTokens;
		});
	}
	updateRunCaps(runId: string, caps: Caps): void {
		this.#update(runId, record => {
			record.caps = caps;
		});
	}
	updateRunScript(runId: string, scriptText: string, scriptHash: string): void {
		this.#update(runId, record => {
			record.scriptText = scriptText;
			record.scriptHash = scriptHash;
		});
	}
	listRuns(query: {
		cwd?: string;
		name?: string;
		parentSessionId?: string;
		statuses?: readonly RunStatus[];
		limit: number;
		cursor?: number;
	}): RunRow[] {
		const where: string[] = [];
		const values: SQLQueryBindings[] = [];
		for (const [key, value] of [
			["cwd", query.cwd],
			["name", query.name],
			["parent", query.parentSessionId],
		] as const)
			if (value !== undefined) {
				where.push(`${key}=?`);
				values.push(value);
			}
		if (query.cursor !== undefined) {
			where.push("rowid<?");
			values.push(query.cursor);
		}
		if (query.statuses !== undefined) {
			if (!query.statuses.length) return [];
			where.push(`status IN (${query.statuses.map(() => "?").join(",")})`);
			values.push(...query.statuses);
		}
		values.push(boundedLimit(query.limit));
		return this.#db
			.query<JsonRow & { created: number; updated: number; cursor: number }, SQLQueryBindings[]>(
				`SELECT json_remove(data,'$.scriptText','$.result','$.failure') AS data,created,updated,rowid AS cursor FROM workflow_run ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY rowid DESC LIMIT ?`,
			)
			.all(...values)
			.map(row => ({
				...decode<RunRecord>(row),
				createdAt: row.created,
				updatedAt: row.updated,
				cursor: row.cursor,
			}));
	}
	putActor(record: ActorRecord): void {
		const { persona, ...data } = record;
		this.#db
			.query(
				"INSERT INTO workflow_actor(run,site,ordinal,name,data,persona) VALUES(?,?,?,?,?,?) ON CONFLICT(run,site,ordinal) DO UPDATE SET name=excluded.name,data=excluded.data,persona=excluded.persona",
			)
			.run(record.runId, record.siteId, record.ordinal, record.name ?? null, JSON.stringify(data), json(persona));
	}
	getActor(runId: string, siteId: string, ordinal: number): ActorRecord | undefined {
		const row = this.#db
			.query<JsonRow, [string, string, number]>(
				"SELECT data,persona FROM workflow_actor WHERE run=? AND site=? AND ordinal=?",
			)
			.get(runId, siteId, ordinal);
		return row
			? { ...decode<ActorRecord>(row), ...(row.persona == null ? {} : { persona: JSON.parse(row.persona) }) }
			: undefined;
	}
	isActorSession(sessionId: string): boolean {
		// actor 归属以持久 journal 为准，不能按会话名或 dwf 前缀猜测并污染主任务索引。
		return this.#db
			.query<{ present: number }, [string]>(
				"SELECT 1 AS present FROM workflow_actor WHERE json_extract(data,'$.sessionId')=? LIMIT 1",
			)
			.get(sessionId) !== null;
	}
	listActors(runId: string, opts: ListActorsOptions): ActorRecord[] {
		return this.#db
			.query<JsonRow, SQLQueryBindings[]>(
				`SELECT data${opts.withPersona ? ",persona" : ""} FROM workflow_actor WHERE run=?${opts.name === undefined ? "" : " AND name=?"} ORDER BY id`,
			)
			.all(...(opts.name === undefined ? [runId] : [runId, opts.name]))
			.map(row => ({
				...decode<ActorRecord>(row),
				...(row.persona == null ? {} : { persona: JSON.parse(row.persona) }),
			}));
	}
	putNode(record: NodeRecord): void {
		const { result, ...data } = record;
		const now = Date.now();
		this.#db
			.query(
				"INSERT INTO workflow_node(run,site,ordinal,kind,artifact,data,result,created,updated) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(run,site,ordinal) DO UPDATE SET kind=excluded.kind,artifact=excluded.artifact,data=excluded.data,result=excluded.result,updated=excluded.updated",
			)
			.run(
				record.runId,
				record.siteId,
				record.ordinal,
				record.kind,
				record.artifactId ?? null,
				JSON.stringify(data),
				json(result),
				now,
				now,
			);
	}
	#node(row: JsonRow): JournalNodeRecord {
		return {
			...decode<NodeRecord>(row),
			...(row.result == null ? {} : { result: JSON.parse(row.result) }),
			...(row.created == null ? {} : { createdAt: row.created }),
			...(row.updated == null ? {} : { updatedAt: row.updated }),
		};
	}
	getNode(runId: string, siteId: string, ordinal: number, opts?: GetNodeOptions): JournalNodeRecord | undefined {
		const row = this.#db
			.query<JsonRow, [string, string, number]>(
				`SELECT data,created,updated${opts?.withResult === false ? "" : ",result"} FROM workflow_node WHERE run=? AND site=? AND ordinal=?`,
			)
			.get(runId, siteId, ordinal);
		return row ? this.#node(row) : undefined;
	}
	listNodes(runId: string, opts: ListNodesOptions): JournalNodeRecord[] {
		if (opts.kinds !== "all" && !opts.kinds.length) return [];
		const kinds = opts.kinds === "all" ? [] : [...opts.kinds];
		const values: SQLQueryBindings[] = [runId, ...kinds];
		// Window sums cap bytes before result text crosses the SQLite boundary; the first row always fits.
		const filter = kinds.length ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : "";
		const budget = opts.withResult && opts.maxResultBytes !== undefined;
		const sql = budget
			? `WITH selected AS (SELECT id,data,result,created,updated,coalesce(length(cast(result AS BLOB)),0) AS bytes FROM workflow_node WHERE run=?${filter}), ranked AS (SELECT *,row_number() OVER(ORDER BY id) AS position,sum(bytes) OVER(ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS total_bytes FROM selected) SELECT data,result,created,updated FROM ranked WHERE position=1 OR total_bytes<=? ORDER BY id LIMIT ?`
			: `SELECT data,created,updated${opts.withResult ? ",result" : ""} FROM workflow_node WHERE run=?${filter} ORDER BY id LIMIT ?`;
		if (budget) values.push(opts.maxResultBytes!);
		values.push(boundedLimit(opts.limit));
		return this.#db
			.query<JsonRow, SQLQueryBindings[]>(sql)
			.all(...values)
			.map(row => this.#node(row));
	}
	countNodes(runId: string, kind: NodeKind): number {
		return this.#db
			.query<{ n: number }, [string, string]>("SELECT count(*) AS n FROM workflow_node WHERE run=? AND kind=?")
			.get(runId, kind)!.n;
	}
	sumResultBytes(runId: string, kind: NodeKind): number {
		return this.#db
			.query<{ n: number }, [string, string]>(
				"SELECT coalesce(sum(length(cast(result AS BLOB))),0) AS n FROM workflow_node WHERE run=? AND kind=?",
			)
			.get(runId, kind)!.n;
	}
	appendEvent(runId: string, event: RunEvent): StoredEvent {
		const timeCreated = Date.now();
		const result = this.#db
			.query("INSERT INTO workflow_event(run,type,created,data) VALUES(?,?,?,?)")
			.run(runId, event.type, timeCreated, JSON.stringify(event));
		return { sequence: Number(result.lastInsertRowid), event, timeCreated };
	}
	listEvents(runId: string, opts: ListEventsOptions): StoredEvent[] {
		if (opts.types !== "all" && !opts.types.length) return [];
		const types = opts.types === "all" ? [] : [...opts.types];
		const values: SQLQueryBindings[] = [];
		let expression = "e.data";
		if (opts.reportItems !== "all") {
			expression =
				"CASE WHEN e.type='report' AND e.sequence>=coalesce((SELECT r.sequence FROM workflow_event r WHERE r.run=? AND r.type='report' ORDER BY r.sequence LIMIT 1 OFFSET ?),9223372036854775807) THEN json_remove(e.data,'$.item') ELSE e.data END";
			values.push(runId, boundedLimit(opts.reportItems.limit));
		}
		values.push(runId, opts.afterSequence ?? -1, ...types, boundedLimit(opts.limit));
		return this.#db
			.query<{ sequence: number; data: string; created: number }, SQLQueryBindings[]>(
				`SELECT e.sequence,${expression} AS data,e.created FROM workflow_event e WHERE e.run=? AND e.sequence>?${types.length ? ` AND e.type IN (${types.map(() => "?").join(",")})` : ""} ORDER BY e.sequence LIMIT ?`,
			)
			.all(...values)
			.map(row => ({ sequence: row.sequence, event: JSON.parse(row.data), timeCreated: row.created }));
	}
	getActors(runId: string, opts: ListActorsOptions = { withPersona: true }): ActorRecord[] {
		return this.listActors(runId, opts);
	}
	getNodes(runId: string, opts: ListNodesOptions = { kinds: "all", withResult: true }): JournalNodeRecord[] {
		return this.listNodes(runId, opts);
	}
	getEvents(runId: string, opts: ListEventsOptions = { types: "all", reportItems: "all" }): StoredEvent[] {
		return this.listEvents(runId, opts);
	}
	getArtifacts(runId: string): ArtifactVersionRecord[] {
		return this.#db
			.query<{ result: string }, string[]>(
				`SELECT n.result FROM workflow_node n WHERE n.run=? AND n.kind='artifact' AND json_extract(n.data,'$.status')='completed' AND n.result IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workflow_node newer WHERE newer.run=n.run AND newer.kind='artifact' AND newer.artifact=n.artifact AND json_extract(newer.data,'$.status')='completed' AND newer.id>n.id) ORDER BY n.id`,
			)
			.all(runId)
			.map(row => JSON.parse(row.result));
	}
	getArtifact(runId: string, artifactId: string, version?: number): ArtifactVersionRecord | undefined {
		const row = this.#db
			.query<{ result: string }, SQLQueryBindings[]>(
				`SELECT result FROM workflow_node WHERE run=? AND artifact=? AND kind='artifact' AND json_extract(data,'$.status')='completed'${version === undefined ? "" : " AND json_extract(result,'$.version')=?"} ORDER BY id DESC LIMIT 1`,
			)
			.get(...(version === undefined ? [runId, artifactId] : [runId, artifactId, version]));
		return row ? JSON.parse(row.result) : undefined;
	}
	listArtifactItems(
		runId: string,
		artifactId: string,
		query: { limit: number; afterSequence?: number },
	): { items: { sequence: number; siteId: string; ordinal: number; item: unknown }[]; hasMore: boolean } {
		const limit = boundedLimit(query.limit);
		const rows = this.#db
			.query<{ sequence: number; site: string; ordinal: number; result: string }, [string, string, number, number]>(
				`SELECT e.sequence,n.site,n.ordinal,n.result FROM workflow_event e JOIN workflow_node n ON n.run=e.run AND n.site=json_extract(e.data,'$.instance.siteId') AND n.ordinal=json_extract(e.data,'$.instance.ordinal') WHERE e.run=? AND e.type='report' AND n.kind='report' AND n.artifact=? AND e.sequence>? ORDER BY e.sequence LIMIT ?`,
			)
			.all(runId, artifactId, query.afterSequence ?? 0, limit + 1);
		return {
			items: rows.slice(0, limit).map(row => ({
				sequence: row.sequence,
				siteId: row.site,
				ordinal: row.ordinal,
				item: JSON.parse(row.result),
			})),
			hasMore: rows.length > limit,
		};
	}
	getWorkspaceNodes(runId: string, query: { limit: number }): WorkspaceNodeRecord[] {
		type SummaryRow = JsonRow & {
			resultBytes: number | null;
			resultCount: number | null;
			exitCode: number | null;
			stdoutBytes: number | null;
			stderrBytes: number | null;
		};
		const rows = this.#db
			.query<SummaryRow, [string, number]>(`SELECT data,created,updated,
   length(cast(result AS BLOB)) AS resultBytes,
   CASE WHEN json_type(result)='array' THEN json_array_length(result) END AS resultCount,
   CASE WHEN json_type(result)='object' THEN json_extract(result,'$.exitCode') END AS exitCode,
   CASE WHEN json_type(result,'$.stdout')='text' THEN length(cast(json_extract(result,'$.stdout') AS BLOB)) END AS stdoutBytes,
   CASE WHEN json_type(result,'$.stderr')='text' THEN length(cast(json_extract(result,'$.stderr') AS BLOB)) END AS stderrBytes
   FROM workflow_node WHERE run=? AND kind IN ('world-read','world-run') ORDER BY id LIMIT ?`)
			.all(runId, boundedLimit(query.limit));
		return rows.map(row => {
			if (row.created == null || row.updated == null)
				throw new Error("Workflow node admission timestamps are unavailable in this legacy journal");
			const summary: Partial<WorkspaceNodeRecord> = {};
			for (const key of ["resultBytes", "resultCount", "exitCode", "stdoutBytes", "stderrBytes"] as const)
				if (typeof row[key] === "number") summary[key] = row[key];
			return { ...this.#node(row), ...summary, createdAt: row.created, updatedAt: row.updated };
		});
	}
}
export function createWorkflowJournal(agentDir: string): OmpWorkflowJournal {
	return new OmpWorkflowJournal(agentDir);
}
