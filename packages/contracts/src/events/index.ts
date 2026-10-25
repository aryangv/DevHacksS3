import { EVENTS_P1 } from "./events.p1";
import { EVENTS_P2 } from "./events.p2";
import { EVENTS_P3 } from "./events.p3";
import { EVENTS_P4 } from "./events.p4";

export { EVENTS_P1, EVENTS_P2, EVENTS_P3, EVENTS_P4 };
export const EVENTS = { ...EVENTS_P1, ...EVENTS_P2, ...EVENTS_P3, ...EVENTS_P4 } as const;
export type EventName = (typeof EVENTS)[keyof typeof EVENTS];
