import test from 'node:test';
import assert from 'node:assert/strict';
import {loadInterviewModule} from './interview-test-loader.mjs';

const lib = loadInterviewModule('interview-self-schedule');
const teams = loadInterviewModule('interview-teams');
const availability = loadInterviewModule('interview-availability');
const tz = loadInterviewModule('interview-timezone');
const MEGHAN = 'meghan.kelly@campus2care.org';
const ZAHA = 'zaha.qamar@campus2care.org';
const SARAH = 'sarah.lee@campus2care.org';
const WEEK = '2026-11-16';
const NOW = new Date('2026-11-15T18:00:00Z');

function confirmed(email, windows = [{weekday: 1, windows: [{startMinute: 540, endMinute: 560}]}]) {
  return {
    eaId: email, weekStart: WEEK, status: 'confirmed', confirmedAt: '2026-11-13T15:00:00.000Z',
    recurringWindows: windows, overrides: [],
  };
}
function instant(record) {
  const slot = availability.buildInterviewSlots(record)[0];
  return tz.easternLocalToInstant(slot.date, slot.startMinute);
}
function person(fields) {
  return {
    active: false, weekly_capacity_limit: 0, allowed_campuses: ['BC'],
    lead_interviewer_id: null, status: null, confirmed_at: null,
    effective_windows: [], date_overrides: [], ...fields,
  };
}
function database(rows) {
  const writes = [];
  const tx = async (parts, ...values) => {
    const sql = parts.join('?');
    writes.push({sql, values});
    if (sql.includes('OR i.lead_interviewer_id')) return rows.team ?? [];
    if (sql.includes('WHERE i.id =')) return rows.subject ?? [];
    if (sql.includes('AS protected')) return rows.slots ?? [];
    if (sql.includes('INSERT INTO interview.schedule_slot')) return rows.insertedSlot ?? [{id: 'new-slot'}];
    if (sql.includes("SELECT participant_id FROM interview.schedule_participant")) return rows.shadows ?? [];
    if (sql.includes("INSERT INTO interview.schedule_participant") && sql.includes("'shadow'")) {
      return rows.shadowInsert ?? [{participant_id: 'shadow'}];
    }
    if (sql.includes('DELETE FROM interview.schedule_participant') && sql.includes("role = 'shadow'")) {
      return [{participant_id: values[1]}];
    }
    return [];
  };
  tx.json = value => value;
  return {tx, writes};
}

test('founder-managed week editing stays limited to Ryan acting for himself', () => {
  assert.equal(lib.canPublishOwnSchedule(lib.RYAN_EMAIL, 'chapter_admin', false), true);
  for (const args of [
    [MEGHAN, 'chapter_admin', false], [lib.RYAN_EMAIL, 'ea', false],
    [lib.RYAN_EMAIL, 'admin', false], [lib.RYAN_EMAIL, 'chapter_admin', true],
  ]) assert.equal(lib.canPublishOwnSchedule(...args), false);
});

test('a lead approves their own campus; a stranger cannot', () => {
  const ryan = {approvedBy: lib.RYAN_EMAIL, campus: 'BC', leadId: 'self', participants: [{id: 'self', email: lib.RYAN_EMAIL, role: 'lead'}]};
  assert.equal(teams.isApprovedInterviewTeam(ryan), true);
  assert.equal(teams.isApprovedInterviewTeam({...ryan, campus: 'BU'}), true);
  assert.equal(teams.isApprovedInterviewTeam({...ryan, leadId: 'other'}), false);
  assert.equal(teams.isApprovedInterviewTeam({...ryan, participants: [{id: 'self', email: 'other@campus2care.org', role: 'lead'}]}), false);
  const meghan = {approvedBy: MEGHAN, campus: 'BU', leadId: 'meghan', participants: [{id: 'meghan', email: MEGHAN, role: 'lead', available: true}]};
  assert.equal(teams.isApprovedInterviewTeam(meghan), true);
  assert.equal(teams.hasRequiredInterviewTeam('BC', [{role: 'lead'}]), true);
  assert.equal(teams.hasRequiredInterviewTeam('BU', [{role: 'shadow'}]), false);
  const covered = teams.bookableInterviewParticipants({
    ...meghan,
    participants: [
      {id: 'meghan', email: MEGHAN, role: 'lead', available: true},
      {id: 'zaha', email: ZAHA, role: 'shadow', available: false},
    ],
  });
  assert.deepEqual(covered.map(person => person.id), ['meghan']);
});

test('legacy Ryan shadower approval stays limited to his own BC lead', () => {
  const team = {approvedBy: lib.RYAN_EMAIL, campus: 'BC', leadId: 'lead', participants: [{id: 'self', email: lib.RYAN_EMAIL, role: 'shadow', assignedLeadId: 'lead'}]};
  assert.equal(teams.isApprovedInterviewTeam(team), true);
  assert.equal(teams.isApprovedInterviewTeam({...team, leadId: 'unrelated'}), false);
  assert.equal(teams.isApprovedInterviewTeam({...team, campus: 'BU'}), false);
});

test('active means host-as-lead; a signed-in shadower with active=false can still be attached', () => {
  const shadow = {team_role: 'shadow', lead_interviewer_id: 'ryan', allowed_campuses: ['BC'], active: false};
  assert.equal(lib.canAttachAsShadow(shadow, 'ryan', 'BC'), true);
  assert.equal(lib.canHostAsLead({...shadow, team_role: 'lead', weekly_capacity_limit: 0}, 'BC'), false);
  assert.equal(lib.canHostAsLead({team_role: 'lead', active: true, weekly_capacity_limit: 10, allowed_campuses: ['BU']}, 'BU'), true);
  assert.equal(lib.canHostAsLead({team_role: 'lead', active: false, weekly_capacity_limit: 10, allowed_campuses: ['BU']}, 'BU'), false);
});

test('an active BU lead publishes and approves her own slot without a shadower', async () => {
  const record = confirmed(MEGHAN);
  const start = instant(record);
  const db = database({
    subject: [person({id: 'meghan', workspace_email: MEGHAN, team_role: 'lead', active: true, weekly_capacity_limit: 10, allowed_campuses: ['BU']})],
    team: [person({id: 'meghan', workspace_email: MEGHAN, team_role: 'lead', active: true, weekly_capacity_limit: 10, allowed_campuses: ['BU']})],
  });
  const result = await lib.publishOwnSchedule(db.tx, 'meghan', record, NOW);
  assert.equal(result.created, 1);
  assert.equal(result.attached, 0);
  const insert = db.writes.find(query => query.sql.includes('INSERT INTO interview.schedule_slot'));
  assert.equal(insert.values[0], 'BU');
  assert.equal(insert.values[4], MEGHAN);
  assert.equal(db.writes.some(query => query.sql.includes('auto_publish_schedule')), true);
  assert.equal(db.writes.some(query => query.values.includes(start.toISOString())), true);
});

test('an inactive lead does not publish slots', async () => {
  const record = confirmed(MEGHAN);
  const db = database({
    subject: [person({id: 'meghan', workspace_email: MEGHAN, team_role: 'lead', active: false, weekly_capacity_limit: 0, allowed_campuses: ['BU']})],
  });
  assert.equal(await lib.publishOwnSchedule(db.tx, 'meghan', record, NOW), undefined);
  assert.equal(db.writes.some(query => query.sql.includes('schedule_slot')), false);
});

test('re-saving keeps a booked slot and removes only an unbooked one', async () => {
  const record = {...confirmed(MEGHAN), status: 'unavailable', recurringWindows: []};
  const booked = new Date('2026-11-17T15:00:00Z');
  const open = new Date('2026-11-18T15:00:00Z');
  const db = database({
    subject: [person({id: 'meghan', workspace_email: MEGHAN, team_role: 'lead', active: true, weekly_capacity_limit: 10, allowed_campuses: ['BU']})],
    team: [person({id: 'meghan', workspace_email: MEGHAN, team_role: 'lead', active: true, weekly_capacity_limit: 10, allowed_campuses: ['BU']})],
    slots: [
      {id: 'booked', lead_id: 'meghan', campus: 'BU', starts_at: booked, approved_by: MEGHAN, protected: true},
      {id: 'open', lead_id: 'meghan', campus: 'BU', starts_at: open, approved_by: MEGHAN, protected: false},
    ],
  });
  const result = await lib.publishOwnSchedule(db.tx, 'meghan', record, NOW);
  assert.equal(result.removed, 1);
  assert.equal(db.writes.some(query => query.values.includes('booked')), false);
  assert.equal(db.writes.filter(query => query.sql.includes('DELETE FROM interview.schedule_slot')).length, 1);
  assert.equal(db.writes.some(query => /UPDATE interview.reservation|DELETE FROM interview.reservation|integration_outbox/.test(query.sql)), false);
});

test('confirming the same hours again does not insert a second slot', async () => {
  const record = confirmed(lib.RYAN_EMAIL, [{weekday: 1, windows: [{startMinute: 540, endMinute: 560}]}]);
  const start = instant(record);
  const db = database({
    subject: [person({id: 'ryan', workspace_email: lib.RYAN_EMAIL, team_role: 'lead', active: true, weekly_capacity_limit: 10, allowed_campuses: ['BC']})],
    team: [person({id: 'ryan', workspace_email: lib.RYAN_EMAIL, team_role: 'lead', active: true, weekly_capacity_limit: 10, allowed_campuses: ['BC']})],
    slots: [{id: 'existing', lead_id: 'ryan', campus: 'BC', starts_at: start, approved_by: lib.RYAN_EMAIL, protected: false}],
  });
  const result = await lib.publishOwnSchedule(db.tx, 'ryan', record, NOW);
  assert.equal(result.created, 0);
  assert.equal(result.removed, 0);
  assert.equal(db.writes.some(query => query.sql.includes('INSERT INTO interview.schedule_slot')), false);
});

test('the current Eastern day is not published; the next day is', async () => {
  const now = new Date('2026-11-16T12:00:00Z');
  const record = confirmed(MEGHAN, [
    {weekday: 0, windows: [{startMinute: 540, endMinute: 560}]},
    {weekday: 1, windows: [{startMinute: 540, endMinute: 560}]},
  ]);
  const [monday, tuesday] = availability.buildInterviewSlots(record)
    .map(slot => tz.easternLocalToInstant(slot.date, slot.startMinute).toISOString());
  const db = database({
    subject: [person({id: 'meghan', workspace_email: MEGHAN, team_role: 'lead', active: true, weekly_capacity_limit: 10, allowed_campuses: ['BU']})],
    team: [person({id: 'meghan', workspace_email: MEGHAN, team_role: 'lead', active: true, weekly_capacity_limit: 10, allowed_campuses: ['BU']})],
  });
  const result = await lib.publishOwnSchedule(db.tx, 'meghan', record, now);
  assert.equal(result.created, 1);
  const insert = db.writes.find(query => query.sql.includes('INSERT INTO interview.schedule_slot'));
  assert.equal(insert.values.includes(monday), false);
  assert.equal(insert.values.includes(tuesday), true);
});

test('a shadower with active=false is attached from confirmed hours and never creates or deletes the slot', async () => {
  const record = confirmed(ZAHA);
  const start = instant(record);
  const db = database({
    subject: [person({id: 'zaha', workspace_email: ZAHA, team_role: 'shadow', lead_interviewer_id: 'ryan', active: false, allowed_campuses: ['BC']})],
    team: [
      person({id: 'ryan', workspace_email: lib.RYAN_EMAIL, team_role: 'lead', active: true, weekly_capacity_limit: 10, allowed_campuses: ['BC']}),
      person({id: 'zaha', workspace_email: ZAHA, team_role: 'shadow', lead_interviewer_id: 'ryan', active: false, allowed_campuses: ['BC']}),
    ],
    slots: [{id: 'open', lead_id: 'ryan', campus: 'BC', starts_at: start, approved_by: lib.RYAN_EMAIL, protected: false}],
  });
  const result = await lib.publishOwnSchedule(db.tx, 'zaha', record, NOW);
  assert.equal(result.attached, 1);
  assert.equal(result.created, 0);
  assert.equal(db.writes.some(query => query.sql.includes('INSERT INTO interview.schedule_slot')), false);
  assert.equal(db.writes.some(query => query.sql.includes('DELETE FROM interview.schedule_slot')), false);
  const attach = db.writes.find(query => query.sql.includes('INSERT INTO interview.schedule_participant'));
  assert.equal(attach.sql.includes("'shadow'"), true);
  assert.deepEqual(attach.values, ['open', 'zaha']);
  assert.equal(db.writes.some(query => query.sql.includes('auto_attach_shadow')), true);
});

test('a shadower withdrawal drops only their unbooked assignment', async () => {
  const record = {...confirmed(ZAHA), status: 'unavailable', recurringWindows: []};
  const db = database({
    subject: [person({id: 'zaha', workspace_email: ZAHA, team_role: 'shadow', lead_interviewer_id: 'ryan', active: false, allowed_campuses: ['BC']})],
    team: [person({id: 'ryan', workspace_email: lib.RYAN_EMAIL, team_role: 'lead', active: true, weekly_capacity_limit: 10, allowed_campuses: ['BC']})],
    slots: [
      {id: 'booked', lead_id: 'ryan', campus: 'BC', starts_at: new Date('2026-11-17T15:00:00Z'), protected: true},
      {id: 'open', lead_id: 'ryan', campus: 'BC', starts_at: new Date('2026-11-18T15:00:00Z'), protected: false},
    ],
  });
  const result = await lib.publishOwnSchedule(db.tx, 'zaha', record, NOW);
  assert.equal(result.detached, 1);
  assert.equal(db.writes.some(query => query.sql.includes('DELETE FROM interview.schedule_slot')), false);
  const withdrawal = db.writes.find(query => query.sql.includes('DELETE FROM interview.schedule_participant'));
  assert.ok(withdrawal.sql.includes("role = 'shadow'"));
  assert.deepEqual(withdrawal.values, ['open', 'zaha']);
  assert.equal(db.writes.some(query => query.values.includes('booked')), false);
});

test('publishing a lead attaches active=false shadowers whose confirmed hours cover the slot', async () => {
  const record = confirmed(lib.RYAN_EMAIL);
  const db = database({
    subject: [person({id: 'ryan', workspace_email: lib.RYAN_EMAIL, team_role: 'lead', active: true, weekly_capacity_limit: 10, allowed_campuses: ['BC']})],
    team: [
      person({id: 'ryan', workspace_email: lib.RYAN_EMAIL, team_role: 'lead', active: true, weekly_capacity_limit: 10, allowed_campuses: ['BC']}),
      person({
        id: 'zaha', workspace_email: ZAHA, team_role: 'shadow', lead_interviewer_id: 'ryan', active: false,
        allowed_campuses: ['BC'], status: 'confirmed', confirmed_at: new Date(record.confirmedAt),
        effective_windows: record.recurringWindows, date_overrides: [],
      }),
      person({
        id: 'sarah', workspace_email: SARAH, team_role: 'shadow', lead_interviewer_id: 'ryan', active: false,
        allowed_campuses: ['BC'], status: 'unavailable', confirmed_at: new Date(record.confirmedAt),
        effective_windows: [], date_overrides: [],
      }),
    ],
  });
  const result = await lib.publishOwnSchedule(db.tx, 'ryan', record, NOW);
  assert.equal(result.created, 1);
  assert.equal(result.attached, 1);
  const shadows = db.writes.filter(query => query.sql.includes('INSERT INTO interview.schedule_participant') && query.sql.includes("'shadow'"));
  assert.deepEqual(shadows.map(query => query.values[1]), ['zaha']);
});

test('booking warning aborts before publication when the acknowledged appointments changed', async () => {
  let committed = false;
  const week = loadInterviewModule('interview-week-choice').interviewWeekChoices(NOW).next;
  const record = {eaId: lib.RYAN_EMAIL, weekStart: week, status: 'unavailable', confirmedAt: NOW.toISOString(), recurringWindows: [], overrides: []};
  const start = new Date(week + 'T15:00:00Z');
  const db = async (parts) => {
    const sql = parts.join('?');
    if (sql.includes('SELECT id FROM interview.interviewer')) return [{id: 'self'}];
    if (sql.includes('SELECT approval_source,revision')) return [{revision: '1', approval_source: 'founder'}];
    if (sql.includes('RETURNING revision::text')) return [{revision: '2'}];
    if (sql.includes('FROM interview.reservation')) return [{id: 'booking', starts_at: start, blocks_until: new Date(+start + 1200000)}];
    return [];
  };
  db.json = value => value;
  db.begin = async callback => { const result = await callback(db); committed = true; return result; };
  const service = loadInterviewModule('interview-week-db', {'./interview-staff-db': {interviewStaffDatabase: () => db, productionStaffEnabled: () => true}});
  for (const acknowledgedAppointments of [undefined, [], ['2099-01-01T00:00:00.000Z']]) {
    await assert.rejects(
      service.saveAuthoritativeInterviewWeek(lib.RYAN_EMAIL, week, record, 'db:1', {allowRyanFounderWeekEdit: true, acknowledgedAppointments}),
      error => error.message === 'booking_warning_required' && error.appointments[0] === start.toISOString(),
    );
    assert.equal(committed, false);
  }
});

test('a founder-managed week is not published for another lead', async () => {
  let committed = false;
  const calls = [];
  const record = confirmed(MEGHAN);
  const db = async (parts) => {
    const sql = parts.join('?');
    calls.push(sql);
    if (sql.includes('SELECT id FROM interview.interviewer')) return [{id: 'meghan'}];
    if (sql.includes('SELECT approval_source,revision')) return [{revision: '1', approval_source: 'founder'}];
    return [];
  };
  db.json = value => value;
  db.begin = async callback => { const result = await callback(db); committed = true; return result; };
  const service = loadInterviewModule('interview-week-db', {'./interview-staff-db': {interviewStaffDatabase: () => db, productionStaffEnabled: () => true}});
  await assert.rejects(
    service.saveAuthoritativeInterviewWeek(MEGHAN, WEEK, record, 'db:1', {}),
    error => error.message === 'founder_managed_week',
  );
  assert.equal(committed, false);
  assert.equal(calls.some(sql => sql.includes('auto_publish_schedule') || sql.includes('schedule_slot')), false);
});
