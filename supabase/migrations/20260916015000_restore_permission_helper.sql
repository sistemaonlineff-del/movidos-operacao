begin;
do $migration$
begin
  if to_regprocedure('public.has_module_permission(text)') is null then
    execute $definition$
      create function public.has_module_permission(permission_name text)
      returns boolean
      language plpgsql stable security definer
      set search_path = public
      as $function$
      declare allowed boolean;
      begin
        if not public.is_active_user() then return false; end if;
        if public.is_admin() then return true; end if;
        execute format(
          'select %I from public.user_module_permissions where user_id = auth.uid()',
          permission_name
        ) into allowed;
        return coalesce(allowed, false);
      end;
      $function$;
    $definition$;
  end if;
end;
$migration$;
commit;