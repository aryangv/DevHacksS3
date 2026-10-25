// Sample Sendblue webhooks. ILLUSTRATIVE: field names follow the payload fields listed in harness-spec 3.1
// (message_handle, is_outbound, service, from_number, sendblue_number, group_id, group_display_name,
// participants, status, ...); the text field (`content`) and timestamps follow Sendblue's docs samples.
// P2 replaces these with real captured fixtures at Gate A (redacted). All numbers are fictional (555).

export const SENDBLUE_LINE = "+15550000000";

export const sendblueReceiveDm = {
  accountEmail: "team@example.invalid",
  content: "hey, what can you do?",
  is_outbound: false,
  status: "RECEIVED",
  error_code: null,
  error_message: null,
  error_detail: null,
  message_handle: "fixture-dm-0001",
  date_sent: "2026-10-24T18:00:00.000Z",
  date_updated: "2026-10-24T18:00:00.000Z",
  from_number: "+15550001001",
  number: "+15550001001",
  to_number: SENDBLUE_LINE,
  sendblue_number: SENDBLUE_LINE,
  was_downgraded: false,
  plan: "ai_agent",
  media_url: "",
  message_type: "message",
  group_id: "",
  participants: [] as string[],
  send_style: "",
  opted_out: false,
  service: "iMessage",
};

export const sendblueReceiveGroup = {
  ...sendblueReceiveDm,
  content: "@agent can we order dinner tonight? keep it under $20 each",
  message_handle: "fixture-group-0001",
  message_type: "group",
  group_id: "fixture-group-id-abc123",
  group_display_name: "Dinner crew",
  from_number: "+15550001001",
  number: "+15550001001",
  participants: ["+15550001001", "+15550001002", "+15550001003", "+15550001004", SENDBLUE_LINE],
};

export const sendblueReceiveGroupChatter = {
  ...sendblueReceiveGroup,
  content: "lol did anyone finish the problem set",
  message_handle: "fixture-group-0002",
  from_number: "+15550001002",
  number: "+15550001002",
};

/** Verify webhook (type "verify"), signed with X-Sendblue-Signature: t=<unix>,v1=<hex HMAC_SHA256(secret, "<t>.<raw_body>")>. */
export const sendblueVerifyApproved = {
  type: "verification.approved",
  data: {
    sid: "VE_fixture_0001",
    service_sid: "VA_fixture_service",
    phone: "+15550001004",
    status: "approved",
  },
  created_at: "2026-10-24T18:05:00.000Z",
};

export const sendblueVerifyExpired = {
  type: "verification.expired",
  data: {
    sid: "VE_fixture_0002",
    service_sid: "VA_fixture_service",
    phone: "+15550001005",
    status: "expired",
  },
  created_at: "2026-10-24T18:10:00.000Z",
};
