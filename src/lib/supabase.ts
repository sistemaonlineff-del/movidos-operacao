import { createClient } from '@supabase/supabase-js'

// Chave publishable: própria para aplicações web; as políticas RLS no Supabase
// continuam protegendo os dados. Não use VITE_SUPABASE_ANON_KEY neste projeto:
// uma chave secret configurada com esse nome seria incorporada ao bundle web.
const url = 'https://hcpvmahmiqipghceylle.supabase.co'
const key = 'sb_publishable_G00DFeIUq-cpbArw5Xeksw_B4f8v6m1'
export const hasSupabaseConfig = Boolean(url && key)
export const supabase = hasSupabaseConfig ? createClient(url, key) : null
