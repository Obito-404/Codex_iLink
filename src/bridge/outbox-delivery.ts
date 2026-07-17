import type {
  PrepareMediaInput,
  SendMediaInput,
} from "../ilink/ilink-client.ts";
import type {
  ILinkSession,
  SendMessageResult,
  SendTextResult,
} from "../ilink/protocol.ts";
import {
  parseOutboundPayload,
  serializeOutboundPayload,
  type PreparedOutboundMedia,
} from "../media/outbound-media.ts";
import { SqliteState, type OutboxItem } from "./sqlite-state.ts";

export type OutboxILinkSender = {
  prepareMedia?(input: PrepareMediaInput): Promise<PreparedOutboundMedia>;
  sendMedia?(input: SendMediaInput): Promise<SendMessageResult>;
  sendText(input: {
    clientId: string;
    contextToken: string;
    session: ILinkSession;
    signal?: AbortSignal;
    text: string;
    timeoutMs?: number;
  }): Promise<SendTextResult>;
};

export async function dispatchOutboxItem(input: {
  contextToken: string;
  ilink: OutboxILinkSender;
  item: OutboxItem;
  session: ILinkSession;
  signal?: AbortSignal;
  state: SqliteState;
}): Promise<OutboxItem> {
  if (input.item.body === null) throw new Error("pending outbox item has no body");
  let item = input.item;
  let payload = parseOutboundPayload(input.item.body);
  if (payload.type === "local-media") {
    if (!input.ilink.prepareMedia || !input.ilink.sendMedia) {
      throw new Error("E_OUTBOUND_MEDIA_UNSUPPORTED");
    }
    const prepared = await input.ilink.prepareMedia({
      media: payload,
      session: input.session,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    item = input.state.replacePendingOutboxBody(
      item.clientId,
      serializeOutboundPayload(prepared),
    );
    payload = prepared;
  }
  if (payload.type === "text") {
    await input.ilink.sendText({
      clientId: item.clientId,
      contextToken: input.contextToken,
      session: input.session,
      ...(input.signal ? { signal: input.signal } : {}),
      text: payload.text,
    });
  } else {
    if (!input.ilink.sendMedia) throw new Error("E_OUTBOUND_MEDIA_UNSUPPORTED");
    await input.ilink.sendMedia({
      clientId: item.clientId,
      contextToken: input.contextToken,
      media: payload,
      session: input.session,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }
  return item;
}
