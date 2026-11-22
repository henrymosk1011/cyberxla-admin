-- The prospect audit scanner is hosted in the cyberxla-patch-reports repo (the
-- GitHub environment can't create a dedicated repo), so its GitHub Actions log
-- in as the existing `report_writer` role rather than `audit_runner`. Let that
-- role call the prospecting.* functions too, so no new database credential is
-- needed. `audit_runner` keeps its own grants for a future dedicated runner.

begin;

grant usage on schema prospecting to report_writer;
grant execute on function
  prospecting.context(),
  prospecting.claim_scan(uuid),
  prospecting.put_findings(uuid, text, integer, text, jsonb, jsonb, text),
  prospecting.scan_failed(uuid, text),
  prospecting.for_render(uuid),
  prospecting.put_files(uuid, integer, bytea, bytea, bytea[]),
  prospecting.render_failed(uuid, integer, text),
  prospecting.claim_send(uuid, boolean),
  prospecting.finish_send(uuid, boolean, text, text),
  prospecting.add_prospects(jsonb)
to report_writer;

commit;
