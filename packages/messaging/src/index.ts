// @campus/messaging — owner: P2 (front door).
//
// Implements MessagingAdapter for iMessage through a BlueBubbles Server (harness-spec Section 7;
// the transport was switched from Sendblue to BlueBubbles by the team). Plugged into the pipeline by
// `createMessagingAdapter` when USE_REAL_MESSAGING=true. Other transports can be added behind the
// same interface later.
//
// Import rule: only @campus/contracts and files inside this package.
import { HarnessError, type MessagingModuleFactory } from "@campus/contracts";
import { BlueBubblesAdapter } from "./bluebubbles/adapter";
import { BlueBubblesHttp } from "./bluebubbles/http";

export { normalizeAddress } from "./address";
export {
  BlueBubblesAdapter,
  WEBHOOK_TOKEN_HEADER,
  type BlueBubblesAdapterOptions,
} from "./bluebubbles/adapter";
export { BlueBubblesHttp, type BlueBubblesHttpOptions, type FetchLike } from "./bluebubbles/http";
export { Throttle } from "./throttle";

/** DI entry point (REAL_MODULES.messaging): loaded by the container when USE_REAL_MESSAGING=true. */
export const createMessagingAdapter: MessagingModuleFactory = (deps) => {
  const c = deps.config;
  if (!c.BLUEBUBBLES_URL || !c.BLUEBUBBLES_PASSWORD || !c.BLUEBUBBLES_WEBHOOK_SECRET) {
    throw new HarnessError(
      "config_invalid",
      "USE_REAL_MESSAGING needs BLUEBUBBLES_URL, BLUEBUBBLES_PASSWORD and BLUEBUBBLES_WEBHOOK_SECRET",
    );
  }
  return new BlueBubblesAdapter({
    http: new BlueBubblesHttp({
      baseUrl: c.BLUEBUBBLES_URL,
      password: c.BLUEBUBBLES_PASSWORD,
      maxPerSecond: c.BLUEBUBBLES_MAX_SENDS_PER_SECOND,
      logger: deps.logger,
    }),
    webhookSecret: c.BLUEBUBBLES_WEBHOOK_SECRET,
    botAddresses: c.BLUEBUBBLES_BOT_ADDRESS ? [c.BLUEBUBBLES_BOT_ADDRESS] : [],
    method: c.BLUEBUBBLES_SEND_METHOD,
    inlineReplies: c.BLUEBUBBLES_INLINE_REPLIES,
    logger: deps.logger,
  });
};
