-- 033: A task linked to a version that has already been released counts as shipped
-- with it (T-19 on factoTime Android v2.9.6 showed no tick in the presentation:
-- it was attached at 10:44, after v2.9.6 was approved as released at 09:20, and
-- only the moment of release stamped targets). A trigger now stamps such links,
-- and the one target already in that state is repaired. Safe to run more than once.

-- (033) A target linked to a version that is ALREADY released ships with it: it takes
-- that version's release time. (Releasing stamps the targets linked at that moment;
-- one linked afterwards — a task attached to v2.9.6 after v2.9.6 went out — was left
-- unticked.) Moving a target to another version follows that version.
create or replace function task_target_release_stamp()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.release_id is not null and (tg_op = 'INSERT' or new.release_id is distinct from old.release_id) then
    new.released_at := coalesce((select r.released_at from releases r where r.id = new.release_id and r.status = 'released'), new.released_at);
  end if;
  return new;
end;
$$;

drop trigger if exists task_targets_release_stamp on task_targets;
create trigger task_targets_release_stamp before insert or update of release_id on task_targets for each row execute function task_target_release_stamp();

-- Repair: targets on a released version that were never stamped.
update task_targets t set released_at = r.released_at
from releases r
where t.release_id = r.id and r.status = 'released' and r.released_at is not null and t.released_at is null;
