export const WECHAT_FINAL_MAX_MESSAGES = 3;
export const WECHAT_TEXT_MAX_UTF8_BYTES = 2_000;

const TRUNCATION_NOTICE =
  "\n\n⚠️ 回复过长，内容已截断；请在 Codex Desktop 查看完整结果。";
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

export type WechatLocalFileReference = {
  label: string;
  path: string;
};

export function extractWechatLocalFileReferences(text: string): {
  references: WechatLocalFileReference[];
  text: string;
} {
  const references: WechatLocalFileReference[] = [];
  const remaining: string[] = [];
  for (const line of text.split(/\r?\n/gu)) {
    const reference = standaloneLocalFileReference(line);
    if (reference) references.push(reference);
    else remaining.push(line);
  }
  return {
    references,
    text: remaining.join("\n").replace(/\n{3,}/gu, "\n\n").trim(),
  };
}

/** Formats one Codex final answer for the bounded WeChat text channel. */
export function formatWechatFinalReply(
  text: string,
  options: { maxMessages?: number } = {},
): string[] {
  text = extractWechatLocalFileReferences(text).text;
  if (text.length === 0) return [];
  const maxMessages = options.maxMessages ?? WECHAT_FINAL_MAX_MESSAGES;
  if (!Number.isSafeInteger(maxMessages) || maxMessages < 1) return [];
  if (Buffer.byteLength(text, "utf8") <= WECHAT_TEXT_MAX_UTF8_BYTES) {
    return [text];
  }

  const messages: string[] = [];
  let remaining = text;
  while (remaining.length > 0 && messages.length < maxMessages) {
    const split = takeUtf8Prefix(remaining, WECHAT_TEXT_MAX_UTF8_BYTES);
    messages.push(split.prefix);
    remaining = split.suffix;
  }
  if (remaining.length === 0) return messages;

  const noticeBytes = Buffer.byteLength(TRUNCATION_NOTICE, "utf8");
  const last = messages.at(-1) ?? "";
  const shortened = takeUtf8Prefix(
    last,
    WECHAT_TEXT_MAX_UTF8_BYTES - noticeBytes,
  ).prefix;
  messages[messages.length - 1] = `${shortened}${TRUNCATION_NOTICE}`;
  return messages;
}

function takeUtf8Prefix(
  text: string,
  maxBytes: number,
): { prefix: string; suffix: string } {
  let bytes = 0;
  let utf16Length = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(text)) {
    const segmentBytes = Buffer.byteLength(segment, "utf8");
    if (bytes + segmentBytes > maxBytes) break;
    bytes += segmentBytes;
    utf16Length += segment.length;
  }
  if (utf16Length === 0 && text.length > 0) {
    for (const character of text) {
      const characterBytes = Buffer.byteLength(character, "utf8");
      if (bytes + characterBytes > maxBytes) break;
      bytes += characterBytes;
      utf16Length += character.length;
    }
  }
  return {
    prefix: text.slice(0, utf16Length),
    suffix: text.slice(utf16Length),
  };
}

function standaloneLocalFileReference(
  line: string,
): WechatLocalFileReference | null {
  const angle = /^\s*!?\[([^\]\r\n]*)\]\(\s*<((?:[A-Za-z]:[\\/]{1,2})[^>\r\n]+)>\s*\)\s*$/u.exec(
    line,
  );
  const plain = angle
    ? null
    : /^\s*!?\[([^\]\r\n]*)\]\(\s*((?:[A-Za-z]:[\\/]{1,2})[^)\r\n]+)\s*\)\s*$/u.exec(
        line,
      );
  const match = angle ?? plain;
  if (!match?.[2]) return null;
  return {
    label: match[1]?.trim() || "附件",
    path: match[2].trim(),
  };
}
