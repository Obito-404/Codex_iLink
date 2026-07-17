import assert from "node:assert/strict";
import test from "node:test";

import {
  buildThreadPreview,
  discoverProjects,
  paginateThreads,
} from "../src/bridge/thread-catalog.ts";

test("projects are deduplicated with Windows path identity and Inbox is excluded", () => {
  const projects = discoverProjects(
    [
      {
        data: [
          {
            cwd: "D:\\Work\\Alpha\\",
            id: "thread-newer",
            updatedAt: 20,
          },
          {
            cwd: "d:/work/alpha",
            id: "thread-older",
            updatedAt: 10,
          },
          {
            cwd: "d:\\codex-data\\INBOX\\",
            id: "thread-inbox",
            updatedAt: 30,
          },
        ],
        nextCursor: null,
      },
    ],
    { inboxCwd: "D:\\Codex-Data\\Inbox" },
  );

  assert.deepEqual(projects, [
    {
      cwd: "D:\\Work\\Alpha",
      threadCount: 2,
      updatedAt: 20,
    },
  ]);
});

test("the WeChat main thread does not create a discoverable project", () => {
  assert.deepEqual(
    discoverProjects(
      [
        {
          data: [
            {
              cwd: "D:\\Only-Main-Uses-This",
              id: "wechat-main",
              updatedAt: 40,
            },
          ],
        },
      ],
      {
        inboxCwd: "D:\\Codex-Data\\Inbox",
        mainThreadId: "wechat-main",
      },
    ),
    [],
  );
});

test("projects are ordered by the newest public thread update", () => {
  assert.deepEqual(
    discoverProjects(
      [
        {
          data: [
            { cwd: "D:\\Older", id: "older", updatedAt: 10 },
            { cwd: "D:\\Newest", id: "newest", updatedAt: 30 },
            { cwd: "D:\\Middle", id: "middle", updatedAt: 20 },
          ],
        },
      ],
      { inboxCwd: "D:\\Codex-Data\\Inbox" },
    ),
    [
      { cwd: "D:\\Newest", threadCount: 1, updatedAt: 30 },
      { cwd: "D:\\Middle", threadCount: 1, updatedAt: 20 },
      { cwd: "D:\\Older", threadCount: 1, updatedAt: 10 },
    ],
  );
});

test("a project's archived sessions are sorted and paged ten at a time", () => {
  const projectThreads = Array.from({ length: 12 }, (_, index) => ({
    cwd: index % 2 === 0 ? "D:\\WORK\\Alpha" : "d:/work/alpha/",
    id: `project-${String(index + 1).padStart(2, "0")}`,
    name: `Task ${index + 1}`,
    status: { type: "idle" },
    updatedAt: index + 1,
  }));

  const page = paginateThreads(
    [
      {
        data: [
          ...projectThreads,
          {
            cwd: "D:\\Work\\Alpha",
            id: "wechat-main",
            updatedAt: 100,
          },
          {
            cwd: "D:\\Work\\Beta",
            id: "other-project",
            updatedAt: 200,
          },
          { id: "no-project", updatedAt: 300 },
        ],
      },
    ],
    {
      archived: true,
      inboxCwd: "D:\\Codex-Data\\Inbox",
      mainThreadId: "wechat-main",
      page: 2,
      projectCwd: "d:\\work\\ALPHA",
    },
  );

  assert.deepEqual(page, {
    archived: true,
    hasNext: false,
    hasPrevious: true,
    items: [
      {
        archived: true,
        cwd: "d:\\work\\alpha",
        id: "project-02",
        status: "idle",
        title: "Task 2",
        updatedAt: 2,
      },
      {
        archived: true,
        cwd: "D:\\WORK\\Alpha",
        id: "project-01",
        status: "idle",
        title: "Task 1",
        updatedAt: 1,
      },
    ],
    page: 2,
    pageSize: 10,
    total: 12,
  });
});

test("the no-project page accepts missing 0.144 fields and treats Inbox as unlisted", () => {
  const page = paginateThreads(
    [
      null,
      {
        data: [
          null,
          { id: "without-cwd" },
          { cwd: "d:/codex-data/inbox/", id: "inbox-thread" },
          { cwd: "D:\\Work\\Alpha", id: "project-thread" },
          { cwd: null, updatedAt: 9 },
        ],
      },
    ],
    {
      archived: false,
      inboxCwd: "D:\\Codex-Data\\Inbox",
      page: 1,
      projectCwd: null,
    },
  );

  assert.deepEqual(page, {
    archived: false,
    hasNext: false,
    hasPrevious: false,
    items: [
      {
        archived: false,
        cwd: "d:\\codex-data\\inbox",
        id: "inbox-thread",
        status: null,
        title: null,
        updatedAt: 0,
      },
      {
        archived: false,
        cwd: null,
        id: "without-cwd",
        status: null,
        title: null,
        updatedAt: 0,
      },
    ],
    page: 1,
    pageSize: 10,
    total: 2,
  });
});

test("a /s n preview exposes only recent user and final agent text, capped at 800", () => {
  const preview = buildThreadPreview({
    model: "gpt-5.6-sol",
    permissionMode: "workspace-write",
    thread: {
      id: "thread-preview",
      name: `${"T".repeat(800)}extra-title`,
      status: { type: "active" },
      turns: [
        {
          items: [
            {
              content: [{ text: "old question", type: "text" }],
              type: "userMessage",
            },
            {
              phase: "final_answer",
              text: "old final answer",
              type: "agentMessage",
            },
          ],
        },
        {
          items: [
            {
              content: [
                { text: "latest question", type: "text" },
                { type: "image", url: "private-image" },
                { text: "second text block", type: "text" },
              ],
              type: "userMessage",
            },
            { summary: ["SECRET_REASONING"], type: "reasoning" },
            { command: "SECRET_COMMAND", type: "commandExecution" },
            { text: "SECRET_TOOL", type: "mcpToolCall" },
            {
              phase: "commentary",
              text: "interim commentary",
              type: "agentMessage",
            },
            {
              phase: "final_answer",
              text: `${"答".repeat(800)}extra-answer`,
              type: "agentMessage",
            },
          ],
        },
      ],
    },
  });

  assert.deepEqual(preview, {
    finalAgentText: "答".repeat(800),
    id: "thread-preview",
    latestUserText: "latest question\nsecond text block",
    model: "gpt-5.6-sol",
    permissionMode: "workspace-write",
    status: "active",
    title: "T".repeat(800),
  });
  assert.ok(!JSON.stringify(preview).includes("SECRET"));
});

test("a thread preview never treats an unphased agent message as final", () => {
  assert.deepEqual(
    buildThreadPreview({
      thread: {
        id: "thread-legacy",
        preview: "fallback title",
        turns: [
          {
            items: [
              {
                content: [{ text: "legacy question", type: "text" }],
                type: "userMessage",
              },
              { text: "legacy final", type: "agentMessage" },
            ],
          },
        ],
      },
    }),
    {
      finalAgentText: null,
      id: "thread-legacy",
      latestUserText: "legacy question",
      model: null,
      permissionMode: null,
      status: null,
      title: "fallback title",
    },
  );
  assert.equal(buildThreadPreview({ thread: {} }), null);
});
