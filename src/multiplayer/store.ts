import { requireSupabase } from '../supabase';
import { createEnvelope, generateCode, isUsableEnvelope } from './protocol';
import type { TableEnvelope, TableSize } from './protocol';

/**
 * The only file in the project that talks to Supabase.
 *
 * The table it writes to is the one that has been there since the first commit —
 * `baazi_rooms(code primary key, state jsonb, updated_at)`. Nothing about it changed to support
 * this: the whole table envelope goes in the existing `state` column, which is why multiplayer
 * needed no migration and no new tables.
 *
 * That column is also what makes safe concurrent writing possible. PostgREST can filter on a jsonb
 * field, so an update conditioned on `state->>revision` is a genuine compare-and-swap: if someone
 * else has written since we read, the filter matches nothing, no row changes, and we find out
 * instead of overwriting them. Verified directly against the live project before this was built.
 */

const TABLE = 'baazi_rooms';

/** How many fresh codes to try before giving up, in case of a collision with a live table. */
const CODE_ATTEMPTS = 8;

export type SaveResult =
  | { ok: true; envelope: TableEnvelope }
  | { ok: false; conflict: true }
  | { ok: false; conflict: false; error: string };

export async function loadTable(code: string): Promise<TableEnvelope | null> {
  const { data, error } = await requireSupabase().from(TABLE).select('state').eq('code', code).maybeSingle();
  if (error || !data) return null;
  // Rows written by the pre-engine prototype are still in this table. They carry a different shape
  // entirely, so they're treated as "no such table" rather than parsed into something wrong.
  return isUsableEnvelope(data.state) ? data.state : null;
}

/**
 * Write, but only if nobody else has. `expectedRevision` is the revision this envelope was derived
 * FROM; the envelope itself already carries the next one.
 *
 * A conflict is not an error — it means somebody else's write landed first and ours was built on a
 * table that no longer exists. The caller reloads and decides again.
 */
export async function saveTable(envelope: TableEnvelope, expectedRevision: number): Promise<SaveResult> {
  const { data, error } = await requireSupabase()
    .from(TABLE)
    .update({ state: envelope, updated_at: new Date().toISOString() })
    .eq('code', envelope.code)
    .eq('state->>revision', String(expectedRevision))
    .select('state');

  if (error) return { ok: false, conflict: false, error: error.message };
  if (!data || data.length === 0) return { ok: false, conflict: true };
  return { ok: true, envelope };
}

/** Make a new table, retrying on the small chance the code is already taken. */
export async function createTable(hostSessionId: string, hostName?: string, size: TableSize = 4): Promise<TableEnvelope> {
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
    const envelope = createEnvelope(generateCode(), hostSessionId, hostName, size);
    const { error } = await requireSupabase().from(TABLE).insert({ code: envelope.code, state: envelope });
    if (!error) return envelope;
    // 23505 is a primary-key collision: that code is in use, so pick another one.
    if ((error as { code?: string }).code !== '23505') {
      throw new Error(`Could not create the table: ${error.message}`);
    }
  }
  throw new Error('Could not find a free game code. Try again.');
}

/**
 * Watch one table. Supabase Realtime was already enabled on this table by the original schema, so
 * this needed no configuration either.
 *
 * The payload carries the new row, so the common case costs no extra round trip; `onChange` is
 * still given a plain envelope so callers never see the transport.
 */
export function watchTable(code: string, onChange: (envelope: TableEnvelope) => void): () => void {
  const client = requireSupabase();
  const channel = client
    .channel(`baazi-${code}`)
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: TABLE, filter: `code=eq.${code}` },
      payload => {
        const next = (payload.new as { state?: unknown } | null)?.state;
        if (isUsableEnvelope(next)) onChange(next);
      }
    )
    .subscribe();

  return () => {
    void client.removeChannel(channel);
  };
}
