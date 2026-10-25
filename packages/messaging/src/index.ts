// @campus/messaging — owner: P2 (front door).
//
// Implements: MessagingAdapter (Sendblue first; Discord/Slack/WhatsApp later) — see
// @campus/contracts interfaces/p2.ts and harness-spec Sections 3.1 and 7.
//
// To plug into the pipeline, export:
//   export const createMessagingAdapter: MessagingModuleFactory = (deps) => new SendblueAdapter(...)
// then flip USE_REAL_MESSAGING=true at integration point I2. Until then the container uses
// FakeMessagingAdapter from @campus/contracts/fakes.
//
// Import rule: only @campus/contracts and files inside this package.
export {};
