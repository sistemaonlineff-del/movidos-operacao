import { createClient } from '@supabase/supabase-js'

// Chave publishable: própria para aplicações web; as políticas RLS no Supabase
// continuam protegendo os dados. As variáveis VITE permitem sobrescrever isso
// em ambientes futuros sem alterar o código.
const url = import.meta.env.VITE_SUPABASE_URL || 'https://hcpvmahmiqipghceylle.supabase.co'
const key = import.meta.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_G00DFeIUq-cpbArw5Xeksw_B4f8v6m1'
export const hasSupabaseConfig = Boolean(url && key)
export const supabase = hasSupabaseConfig ? createClient(url, key) : null
