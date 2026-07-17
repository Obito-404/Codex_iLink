export const WECHAT_FINAL_MAX_MESSAGES = 3;
export const WECHAT_TEXT_MAX_UTF8_BYTES = 2_000;

const TRUNCATION_NOTICE =
  "\n\n⚠️ 回复过长，内容已截断；请在 Codex Desktop 查看完整结果。";
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

/** Formats one Codex final answer for the bounded WeChat text channel. */
export function formatWechatFinalReply(text: string): string[] {
  if (Buffer.byteLength(text, "utf8") <= WECHAT_TEXT_MAX_UTF8_BYTES) {
    return [text];
  }

  const messages: string[] = [];
  let remaining = text;
  while (remaining.length > 0 && messages.length < WECHAT_FINAL_MAX_MESSAGES) {
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
