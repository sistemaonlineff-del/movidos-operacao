begin;
revoke all on function public.drop_registration_reserve(uuid,text,jsonb,jsonb,text),public.drop_registration_finalize(uuid,text) from service_role;
revoke all on function public.drop_registration_authorize(uuid),public.drop_registration_duplicates(jsonb,uuid),public.drop_registration_review(uuid,integer,text,jsonb,text,text,text,uuid) from service_role;
notify pgrst,'reload schema';
commit;