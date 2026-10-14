import type { PoolClient } from "./pg-pool.ts";
import type { ScopeId } from "../types.ts";

export function isArtifactPath(path: string): boolean {
  return /^artifacts\/[0-9a-f]{32}\//.test(path);
}

function isArtifactId(ref: string): boolean {
  return /^[0-9a-f]{32}$/.test(ref);
}

export async function lockGrantResource(client: PoolClient, ownerScopeId: ScopeId, ref: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`acl-grants:${ownerScopeId}\n${ref}`]);
}

export async function requireArtifactResource(client: PoolClient, ownerScopeId: ScopeId, ref: string): Promise<void> {
  if (!isArtifactId(ref)) return;
  const table = await client.query("SELECT to_regclass('file_artifacts') AS name");
  if (!table.rows[0].name) return;
  const result = await client.query("SELECT 1 FROM file_artifacts WHERE owner_scope_id = $1 AND id = $2", [
    ownerScopeId,
    ref,
  ]);
  if (!result.rowCount) throw new Error("artifact resource does not exist");
}

export async function requireActiveArtifactRun(client: PoolClient, runId: string): Promise<void> {
  const result = await client.query("SELECT status FROM runs WHERE id = $1 FOR SHARE", [runId]);
  if (!result.rows.length || !["pending", "running"].includes(result.rows[0].status)) {
    throw new Error("inbound artifact run is no longer active");
  }
}

export async function artifactIsReferenced(client: PoolClient, id: string): Promise<boolean> {
  const table = await client.query("SELECT to_regclass('session_entries') AS name");
  if (!table.rows[0].name) return false;
  const ready = await client.query("SELECT to_regprocedure('session_artifact_ids(text)') AS name");
  if (!ready.rows[0].name) return true;
  const result = await client.query(
    "SELECT 1 FROM session_entries WHERE session_artifact_ids(payload) @> ARRAY[$1]::text[] LIMIT 1",
    [id],
  );
  return Boolean(result.rowCount);
}

export async function artifactIsGranted(client: PoolClient, ownerScopeId: ScopeId, ref: string): Promise<boolean> {
  const table = await client.query("SELECT to_regclass('acl_grants') AS name");
  if (!table.rows[0].name) return false;
  const result = await client.query("SELECT 1 FROM acl_grants WHERE owner_scope_id = $1 AND path = $2 LIMIT 1", [
    ownerScopeId,
    ref,
  ]);
  return Boolean(result.rowCount);
}

export async function requireEntryArtifacts(client: PoolClient, payloads: readonly unknown[]): Promise<void> {
  const ids = [
    ...new Set(
      payloads
        .flatMap((payload) => {
          const attachments = (payload as { attachments?: unknown } | null)?.attachments;
          return Array.isArray(attachments) ? attachments : [];
        })
        .map((a: { artifactId?: unknown } | null) => a?.artifactId)
        .filter((id): id is string => typeof id === "string"),
    ),
  ].sort();
  if (!ids.length) return;
  const table = await client.query("SELECT to_regclass('file_artifacts') AS name");
  if (!table.rows[0].name) return;
  const resources = await client.query("SELECT id, owner_scope_id FROM file_artifacts WHERE id = ANY($1)", [ids]);
  if (resources.rowCount !== ids.length) throw new Error("session references a missing artifact");
  for (const resource of resources.rows.sort((a, b) =>
    `${a.owner_scope_id}\n${a.id}`.localeCompare(`${b.owner_scope_id}\n${b.id}`),
  )) {
    await lockGrantResource(client, resource.owner_scope_id as ScopeId, resource.id);
    await requireArtifactResource(client, resource.owner_scope_id as ScopeId, resource.id);
  }
}
