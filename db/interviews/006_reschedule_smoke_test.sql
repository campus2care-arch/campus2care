-- Single-statement synthetic test. Its exception subtransaction rolls back all writes.
DO $$
DECLARE
  ea uuid; invite_a uuid; invite_b uuid; original uuid; rejected boolean;
BEGIN
  BEGIN
    INSERT INTO interview.interviewer(workspace_email,display_name,allowed_campuses) VALUES('reschedule-'||gen_random_uuid()::text||'@example.invalid','Synthetic reschedule smoke',ARRAY['BU']) RETURNING id INTO ea;
    INSERT INTO interview.invitation(campus,notion_page_id,recipient_hmac,token_hash,expires_at,email_verified_at) VALUES('BU','synthetic-reschedule-a',repeat('d',64),md5(random()::text)||md5(random()::text),now()+interval '1 day',now()) RETURNING id INTO invite_a;
    INSERT INTO interview.invitation(campus,notion_page_id,recipient_hmac,token_hash,expires_at,email_verified_at) VALUES('BU','synthetic-reschedule-b',repeat('e',64),md5(random()::text)||md5(random()::text),now()+interval '1 day',now()) RETURNING id INTO invite_b;
    INSERT INTO interview.reservation(invitation_id,campus,notion_page_id,recipient_hmac,interviewer_id,starts_at,ends_at,blocks_until,status) VALUES(invite_a,'BU','synthetic-reschedule-a',repeat('d',64),ea,'2099-11-02T14:00:00Z','2099-11-02T14:20:00Z','2099-11-02T14:25:00Z','confirmed') RETURNING id INTO original;
    INSERT INTO interview.slot_claim(claim_key,interviewer_id,starts_at,blocks_until) VALUES('reschedule:synthetic-smoke',ea,'2099-11-02T15:00:00Z','2099-11-02T15:25:00Z');
    rejected:=false;
    BEGIN
      INSERT INTO interview.reservation(invitation_id,campus,notion_page_id,recipient_hmac,interviewer_id,starts_at,ends_at,blocks_until,status) VALUES(invite_b,'BU','synthetic-reschedule-b',repeat('e',64),ea,'2099-11-02T15:00:00Z','2099-11-02T15:20:00Z','2099-11-02T15:25:00Z','calendar_pending');
    EXCEPTION WHEN exclusion_violation THEN rejected:=true; END;
    IF NOT rejected THEN RAISE EXCEPTION 'replacement_claim_not_protected'; END IF;
    IF NOT EXISTS(SELECT 1 FROM interview.reservation WHERE id=original AND starts_at='2099-11-02T14:00:00Z' AND status='confirmed') THEN RAISE EXCEPTION 'original_changed_before_replacement'; END IF;
    DELETE FROM interview.slot_claim WHERE claim_key='reschedule:synthetic-smoke';
    UPDATE interview.slot_claim SET claim_key='retired:synthetic-smoke' WHERE claim_key='reservation:'||original::text;
    UPDATE interview.reservation SET starts_at='2099-11-02T15:00:00Z',ends_at='2099-11-02T15:20:00Z',blocks_until='2099-11-02T15:25:00Z' WHERE id=original;
    rejected:=false;
    BEGIN
      INSERT INTO interview.reservation(invitation_id,campus,notion_page_id,recipient_hmac,interviewer_id,starts_at,ends_at,blocks_until,status) VALUES(invite_b,'BU','synthetic-reschedule-b',repeat('e',64),ea,'2099-11-02T14:00:00Z','2099-11-02T14:20:00Z','2099-11-02T14:25:00Z','calendar_pending');
    EXCEPTION WHEN exclusion_violation THEN rejected:=true; END;
    IF NOT rejected THEN RAISE EXCEPTION 'original_slot_released_before_calendar_cleanup'; END IF;
    DELETE FROM interview.slot_claim WHERE claim_key='retired:synthetic-smoke';
    INSERT INTO interview.reservation(invitation_id,campus,notion_page_id,recipient_hmac,interviewer_id,starts_at,ends_at,blocks_until,status) VALUES(invite_b,'BU','synthetic-reschedule-b',repeat('e',64),ea,'2099-11-02T14:00:00Z','2099-11-02T14:20:00Z','2099-11-02T14:25:00Z','calendar_pending');
    RAISE EXCEPTION USING ERRCODE='Z0001',MESSAGE='rollback_successful_synthetic_test';
  EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL;
  END;
END $$;
