import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  localOutboundMedia,
  outboundMediaPathKey,
  pruneOutboundMediaSnapshots,
  readStagedOutboundMedia,
  stageOutboundMedia,
} from "../src/media/outbound-media.ts";

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

test("outbound staging rejects a file outside the task workspace", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-outbound-boundary-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const workspaceRoot = join(directory, "workspace");
  const exportRoot = join(directory, "private", "outbound");
  const outsidePath = join(directory, "secret.txt");
  mkdirSync(workspaceRoot);
  writeFileSync(outsidePath, "not task output");

  assert.throws(
    () =>
      stageOutboundMedia({
        exportRoot,
        label: "secret.txt",
        path: outsidePath,
        workspaceRoot,
      }),
    /E_OUTBOUND_MEDIA_OUTSIDE_WORKSPACE/u,
  );
});

test("outbound staging snapshots the accepted workspace file", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-outbound-snapshot-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const workspaceRoot = join(directory, "workspace");
  const exportRoot = join(directory, "private", "outbound");
  const sourcePath = join(workspaceRoot, "report.txt");
  mkdirSync(workspaceRoot);
  writeFileSync(sourcePath, "approved contents");

  const media = stageOutboundMedia({
    exportRoot,
    label: "report.txt",
    path: sourcePath,
    workspaceRoot,
  });
  writeFileSync(sourcePath, "changed after send_file");

  assert.equal(media.name, "report.txt");
  assert.equal(readFileSync(media.path, "utf8"), "approved contents");
  assert.equal(
    readStagedOutboundMedia({
      exportRoot,
      label: media.name,
      path: media.path,
    }).plaintext.toString("utf8"),
    "approved contents",
  );
  writeFileSync(media.path, "tampered snapshot");
  assert.throws(
    () =>
      readStagedOutboundMedia({
        exportRoot,
        label: media.name,
        path: media.path,
      }),
    /E_OUTBOUND_MEDIA_CHANGED/u,
  );
});

test("outbound staging rejects device, UNC, drive-relative, and ADS paths", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-outbound-paths-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const workspaceRoot = join(directory, "workspace");
  const exportRoot = join(directory, "private", "outbound");
  mkdirSync(workspaceRoot);

  for (const path of [
    "\\\\server\\share\\secret.txt",
    "\\\\?\\C:\\secret.txt",
    "C:relative.txt",
    "C:\\workspace\\report.txt:secret",
  ]) {
    assert.throws(
      () =>
        stageOutboundMedia({
          exportRoot,
          label: "secret.txt",
          path,
          workspaceRoot,
        }),
      /E_OUTBOUND_MEDIA_PATH/u,
      path,
    );
  }
});

test("outbound staging rejects hard links", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-outbound-hardlink-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const workspaceRoot = join(directory, "workspace");
  const exportRoot = join(directory, "private", "outbound");
  const sourcePath = join(workspaceRoot, "report.txt");
  const linkedPath = join(workspaceRoot, "linked.txt");
  mkdirSync(workspaceRoot);
  writeFileSync(sourcePath, "linked contents");
  linkSync(sourcePath, linkedPath);

  assert.throws(
    () =>
      stageOutboundMedia({
        exportRoot,
        label: "report.txt",
        path: sourcePath,
        workspaceRoot,
      }),
    /E_OUTBOUND_MEDIA_LINK/u,
  );
});

test("outbound staging rejects a junction escaping the workspace", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-outbound-junction-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const workspaceRoot = join(directory, "workspace");
  const outsideRoot = join(directory, "outside");
  const exportRoot = join(directory, "private", "outbound");
  const junctionPath = join(workspaceRoot, "escape");
  mkdirSync(workspaceRoot);
  mkdirSync(outsideRoot);
  writeFileSync(join(outsideRoot, "secret.txt"), "outside");
  try {
    symlinkSync(outsideRoot, junctionPath, "junction");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("junction creation requires Windows developer privileges");
      return;
    }
    throw error;
  }

  assert.throws(
    () =>
      stageOutboundMedia({
        exportRoot,
        label: "secret.txt",
        path: join(junctionPath, "secret.txt"),
        workspaceRoot,
      }),
    /E_OUTBOUND_MEDIA_LINK/u,
  );
});

test("outbound snapshot pruning keeps durable references and ignores other files", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-outbound-prune-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const workspaceRoot = join(directory, "workspace");
  const exportRoot = join(directory, "private", "outbound");
  mkdirSync(workspaceRoot);
  const retainedSource = join(workspaceRoot, "retained.txt");
  const orphanSource = join(workspaceRoot, "orphan.txt");
  writeFileSync(retainedSource, "retained");
  writeFileSync(orphanSource, "orphan");
  const retained = stageOutboundMedia({
    exportRoot,
    label: "retained.txt",
    path: retainedSource,
    workspaceRoot,
  });
  const orphan = stageOutboundMedia({
    exportRoot,
    label: "orphan.txt",
    path: orphanSource,
    workspaceRoot,
  });
  const unrelated = join(exportRoot, "notes.txt");
  writeFileSync(unrelated, "not managed by iLink");

  assert.equal(
    pruneOutboundMediaSnapshots({
      exportRoot,
      retainedPathKeys: new Set([outboundMediaPathKey(retained.path)]),
    }),
    1,
  );
  assert.equal(existsSync(retained.path), true);
  assert.equal(existsSync(orphan.path), false);
  assert.equal(existsSync(unrelated), true);
});
