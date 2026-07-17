import assert from "node:assert/strict";
import test from "node:test";

import {
  protectForCurrentUser,
  unprotectForCurrentUser,
} from "../src/windows/dpapi.ts";

test(
  "iLink credentials round-trip through Windows CurrentUser DPAPI",
  { skip: process.platform !== "win32" },
  () => {
    const plaintext = "token-value-that-must-not-be-stored-directly";
    const protectedValue = protectForCurrentUser(plaintext);

    assert.notEqual(protectedValue, plaintext);
    assert.ok(protectedValue.length > plaintext.length);
    assert.equal(unprotectForCurrentUser(protectedValue), plaintext);
  },
);

test(
  "invalid protected credential data is rejected",
  { skip: process.platform !== "win32" },
  () => {
    assert.throws(
      () => unprotectForCurrentUser("bm90LWRwYXBp"),
      /E_CREDENTIAL_DECRYPT/u,
    );
  },
);
