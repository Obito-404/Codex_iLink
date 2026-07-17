import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { localOutboundMedia } from "../src/media/outbound-media.ts";

test("an overlong outbound name keeps the source file extension", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-outbound-name-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const path = join(directory, "报销单.pdf");
  writeFileSync(path, "%PDF-1.4\n% fixture");

  const media = localOutboundMedia({
    label: `${"a".repeat(240)}.pdf`,
    path,
  });

  assert.equal(media.name, `${"a".repeat(236)}.pdf`);
  assert.equal(media.name.length, 240);
});
