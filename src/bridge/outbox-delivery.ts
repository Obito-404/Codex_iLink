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
  readStagedOutboundMedia,
  removeOutboundMediaSnapshot,
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

const UNSAFE_LOCAL_MEDIA_REJECTED_TEXT =
  "⚠️ 附件记录未通过当前安全校验，未发送本机文件；请在新的 iLink 任务中重新发送。";

export async function dispatchOutboxItem(input: {
  contextToken: string;
  ilink: OutboxILinkSender;
  item: OutboxItem;
  outboundDirectory?: string;
  session: ILinkSession;
  signal?: AbortSignal;
  state: SqliteState;
}): Promise<OutboxItem> {
  if (input.item.body === null) throw new Error("pending outbox item has no body");
  let item = input.item;
  let payload = parseOutboundPayload(input.item.body);
  let stagedPlaintext: Uint8Array | undefined;
  if (payload.type === "local-media" && payload.staged !== true) {
    item = input.state.replacePendingOutboxBody(
      item.clientId,
      UNSAFE_LOCAL_MEDIA_REJECTED_TEXT,
    );
    payload = { text: UNSAFE_LOCAL_MEDIA_REJECTED_TEXT, type: "text" };
  }
  if (payload.type === "local-media") {
    try {
      if (!input.outboundDirectory) throw new Error("E_OUTBOUND_MEDIA_ROOT");
      const staged = readStagedOutboundMedia({
        exportRoot: input.outboundDirectory,
        label: payload.name,
        path: payload.path,
      });
      payload = staged.media;
      stagedPlaintext = staged.plaintext;
    } catch {
      if (input.outboundDirectory) {
        removeOutboundMediaSnapshot(payload.path, input.outboundDirectory);
      }
      item = input.state.replacePendingOutboxBody(
        item.clientId,
        UNSAFE_LOCAL_MEDIA_REJECTED_TEXT,
      );
      payload = { text: UNSAFE_LOCAL_MEDIA_REJECTED_TEXT, type: "text" };
    }
  }
  if (payload.type === "local-media") {
    if (!input.ilink.prepareMedia || !input.ilink.sendMedia) {
      throw new Error("E_OUTBOUND_MEDIA_UNSUPPORTED");
    }
    const prepared = await input.ilink.prepareMedia({
      media: payload,
      ...(stagedPlaintext ? { plaintext: stagedPlaintext } : {}),
      session: input.session,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    item = input.state.replacePendingOutboxBody(
      item.clientId,
      serializeOutboundPayload(prepared),
    );
    if (input.outboundDirectory) {
      removeOutboundMediaSnapshot(payload.path, input.outboundDirectory);
    }
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
