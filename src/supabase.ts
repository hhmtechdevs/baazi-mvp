import { createClient } from '@supabase/supabase-js';

/**
 * The Supabase client, or nothing.
 *
 * Deliberately does NOT construct the client unconditionally. `createClient` throws
 * "supabaseUrl is required." the moment it is called without configuration, and because this module
 * is reached through a static import chain from the app's entry point, that throw would take down
 * the whole page — including Practice, which needs no network at all. A misconfigured deploy should
 * cost you shared tables, not the entire game.
 *
 * So: a missing or blank value leaves `supabase` null, `isSupabaseConfigured` false, and the Family
 * door disabled with an explanation, while Practice carries on exactly as before.
 */

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

export const isSupabaseConfigured = Boolean(url && anonKey);

export const supabase = isSupabaseConfigured ? createClient(url!, anonKey!) : null;

/** For the transport layer, which cannot do anything useful without a client. The message is
 * written for whoever is looking at a broken deploy, not for a player. */
export function requireSupabase(): NonNullable<typeof supabase> {
  if (!supabase) {
    throw new Error(
      'Shared games need VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to be set at build time.'
    );
  }
  return supabase;
}
