import { supabase } from '../lib/supabase';
import { validateState } from './domain';
import type { Envelope, FinancialState } from './domain';

export const workspaceId = 'f1082026-1108-4000-8000-000000000001';
export let canWrite = false;

export async function loadState(): Promise<Envelope> {
  canWrite = false;
  if (!supabase) throw new Error('Supabase indisponivel.');
  const { data: session, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !session.session) throw new Error('Sessao indisponivel. Use o acesso do sistema para entrar novamente.');
  const { data: membership, error: memberError } = await supabase.from('financas_members')
    .select('role').eq('workspace_id', workspaceId).eq('user_id', session.session.user.id).single();
  if (memberError || membership?.role !== 'editor') throw new Error('Usuario sem acesso a estas financas privadas.');
  const { data, error } = await supabase.from('financas_books')
    .select('revision,payload,updated_at').eq('workspace_id', workspaceId).single();
  if (error) throw new Error(error.message);
  validateState(data.payload);
  if (!Number.isSafeInteger(data.revision) || data.revision < 0 || typeof data.updated_at !== 'string') throw new Error('Revisao financeira invalida.');
  canWrite = true;
  return { revision: data.revision, data: data.payload, updatedAt: data.updated_at };
}

export async function saveState(previous: Envelope, data: FinancialState): Promise<Envelope> {
  if (!supabase || !canWrite) throw new Error('Permissao de edicao necessaria.');
  if (!Number.isSafeInteger(previous.revision) || previous.revision < 0) throw new Error('Revisao financeira invalida. Atualize a base.');
  validateState(data);
  const { data: result, error } = await supabase.rpc('financas_save_book', {
    target_workspace: workspaceId, expected_revision: previous.revision, new_payload: data,
  });
  if (error) throw new Error(error.message);
  if (result?.revision !== previous.revision + 1 || typeof result.updated_at !== 'string') {
    throw new Error('Confirmacao de salvamento indisponivel. Atualize e confira antes de repetir.');
  }
  return { revision: result.revision, data, updatedAt: result.updated_at };
}

export async function loadHistory(): Promise<{ revision: number; changed_at: string; changed_by: string }[]> {
  if (!supabase) throw new Error('Supabase indisponivel.');
  const { data, error } = await supabase.from('financas_history').select('revision,changed_at,changed_by')
    .eq('workspace_id', workspaceId).order('revision', { ascending: false }).limit(100);
  if (error) throw new Error(error.message);
  return data ?? [];
}