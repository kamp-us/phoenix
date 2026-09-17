/**
 * `@kampus/tuval-notify` — the front door. One row factory and the types a config annotates it
 * with; `notifyProgram` and the constants beside it are here because the test drives the authored
 * record directly, and because a consumer that wants the history bound or the status sentence
 * should read the one this program uses rather than restate it.
 */

export {
  DELIVER,
  type Deliver,
  type DeliveredEvent,
  deliver,
  deliveredEvent,
  deliverHandler,
  type FakeTransport,
  fakeTransport,
  liveTransport,
  Transport,
} from "./deliver.ts";
export {
  DEFAULT_ID,
  DeliveredSchema,
  type Message,
  MessageSchema,
  type NotifyOptions,
  notify,
  notifyProgram,
  SendRequest,
} from "./notify.ts";
export {
  NOTIFY_WINDOW_REF,
  type RendererKind,
  type RendererRef,
} from "./renderer-ref.ts";
export {
  asTurn,
  type Delivery,
  type DeliveryView,
  DROPPED,
  delivery,
  drained,
  dropped,
  EMPTY_OUTBOX,
  firstLine,
  full,
  HISTORY,
  hhmm,
  isDelivery,
  isNotifyState,
  type NotifySendEvent,
  type NotifyState,
  type NotifyWindowView,
  notifyView,
  OUTBOX,
  type Outbox,
  outcome,
  pending,
  queued,
  readable,
  recorded,
  type SendingView,
  sendEvent,
  statusLine,
  type Turn,
  titleLine,
} from "./state.ts";
export {
  type Attempt,
  attemptDelivery,
  type Fetch,
  type NotifyTarget,
  type NtfyTarget,
  ntfyUrl,
  type Outgoing,
  type StdoutTarget,
  type TargetKind,
  TIMEOUT,
  type WebhookTarget,
  type Write,
} from "./target.ts";
