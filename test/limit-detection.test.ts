import assert from "node:assert/strict";
import { test } from "vitest";
import {
  classifyAnthropicError,
  isAccountUsageLimitError,
} from "#src/limit-detection";

test("classifies per-account quota failures as usage-limit", () => {
  const messages = [
    '429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your account\'s rate limit"}}',
    "Claude Pro usage limit reached. Your limit will reset at 3PM.",
    "400 quota exceeded for this organization",
  ];

  for (const message of messages) {
    assert.equal(classifyAnthropicError(message), "usage-limit", message);
    assert.equal(isAccountUsageLimitError(message), true, message);
  }
});

test("classifies credential rejections as auth", () => {
  const messages = [
    '401 {"type":"error","error":{"type":"authentication_error","message":"invalid bearer token"}}',
    "Anthropic token refresh failed: invalid_grant",
  ];

  for (const message of messages) {
    assert.equal(classifyAnthropicError(message), "auth", message);
    assert.equal(isAccountUsageLimitError(message), false, message);
  }
});

test("never rotates on Anthropic-wide overload", () => {
  const message =
    '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';

  assert.equal(classifyAnthropicError(message), "other");
});

test("never rotates on the misleading extra-usage 400", () => {
  // This 400 signals a request-shaping problem, not an account quota problem.
  const message =
    '400 {"type":"error","error":{"type":"invalid_request_error","message":"You\'re out of extra usage."}}';

  assert.equal(classifyAnthropicError(message), "other");
});

test("treats unknown, empty, and missing messages as other", () => {
  assert.equal(classifyAnthropicError(undefined), "other");
  assert.equal(classifyAnthropicError(""), "other");
  assert.equal(classifyAnthropicError("socket hang up"), "other");
  assert.equal(classifyAnthropicError("500 internal server error"), "other");
});

test("does not confuse a 429 inside an unrelated number with a status code", () => {
  assert.equal(
    classifyAnthropicError("request id req_1042900 failed"),
    "other",
  );
});
