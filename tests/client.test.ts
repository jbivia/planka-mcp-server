/**
 * HTTP client: auth headers, error mapping and token refresh.
 *
 * `fetch` is replaced wholesale, so nothing here touches the network. The
 * assertions are about the two things the client exists for — putting the right
 * credential on the right header, and turning Planka's opaque status codes into
 * a sentence the agent can act on.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { loadConfig, resetConfigForTesting } from "../src/config.js";
import { PlankaError, formatError } from "../src/errors.js";
import { resetAuthForTesting } from "../src/services/auth.js";
import { apiRequest } from "../src/services/client.js";

const originalEnv = { ...process.env };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let calls: Call[] = [];

/** Replace fetch with a queue of canned responses, recording every request. */
function stubFetch(responses: { status: number; body?: unknown }[]): void {
  let index = 0;
  mock.method(globalThis, "fetch", async (input: unknown, init: RequestInit = {}) => {
    const canned = responses[Math.min(index, responses.length - 1)];
    index += 1;
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    // A 204 must carry a null body, not an empty string: the Response
    // constructor rejects any body on a no-content status.
    return new Response(canned?.body === undefined ? null : JSON.stringify(canned.body), {
      status: canned?.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

function setEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfigForTesting();
  resetAuthForTesting();
}

beforeEach(() => {
  calls = [];
  setEnv({
    PLANKA_BASE_URL: "https://planka.example.com",
    PLANKA_TOKEN: "abcdef_api_key",
    PLANKA_EMAIL: undefined,
    PLANKA_PASSWORD: undefined,
  });
});

afterEach(() => {
  mock.restoreAll();
  process.env = { ...originalEnv };
  resetConfigForTesting();
  resetAuthForTesting();
});

describe("config", () => {
  it("appends /api and tolerates it already being there", () => {
    assert.equal(loadConfig().apiUrl, "https://planka.example.com/api");
    setEnv({ PLANKA_BASE_URL: "https://planka.example.com/api/" });
    assert.equal(loadConfig().apiUrl, "https://planka.example.com/api");
  });

  it("refuses a half-finished credential pair", () => {
    setEnv({ PLANKA_TOKEN: undefined, PLANKA_EMAIL: "jane@example.com", PLANKA_PASSWORD: undefined });
    assert.throws(() => loadConfig(), /No Planka credentials configured/);
  });
});

describe("authentication headers", () => {
  it("sends an opaque API key on X-Api-Key", async () => {
    stubFetch([{ status: 200, body: { items: [] } }]);
    await apiRequest("/projects");
    assert.equal(calls[0]?.headers["X-Api-Key"], "abcdef_api_key");
    assert.equal(calls[0]?.headers["Authorization"], undefined);
  });

  it("sends a three-segment JWT as a bearer token", async () => {
    setEnv({ PLANKA_TOKEN: "aaa.bbb.ccc" });
    stubFetch([{ status: 200, body: { items: [] } }]);
    await apiRequest("/projects");
    assert.equal(calls[0]?.headers["Authorization"], "Bearer aaa.bbb.ccc");
    assert.equal(calls[0]?.headers["X-Api-Key"], undefined);
  });

  it("exchanges email and password for a token, once, then reuses it", async () => {
    setEnv({ PLANKA_TOKEN: undefined, PLANKA_EMAIL: "jane@example.com", PLANKA_PASSWORD: "secret" });
    stubFetch([
      { status: 200, body: { item: "aaa.bbb.ccc" } },
      { status: 200, body: { items: [] } },
      { status: 200, body: { items: [] } },
    ]);

    await apiRequest("/projects");
    await apiRequest("/projects");

    assert.equal(calls[0]?.url, "https://planka.example.com/api/access-tokens");
    assert.deepEqual(calls[0]?.body, {
      emailOrUsername: "jane@example.com",
      password: "secret",
    });
    // Three calls, not four: the second request reuses the cached token.
    assert.equal(calls.length, 3);
    assert.equal(calls[2]?.headers["Authorization"], "Bearer aaa.bbb.ccc");
  });
});

describe("token refresh", () => {
  it("signs in again and replays once when an exchanged token expires", async () => {
    setEnv({ PLANKA_TOKEN: undefined, PLANKA_EMAIL: "jane@example.com", PLANKA_PASSWORD: "secret" });
    stubFetch([
      { status: 200, body: { item: "aaa.bbb.ccc" } },
      { status: 401, body: { code: "E_UNAUTHORIZED", message: "expired" } },
      { status: 200, body: { item: "ddd.eee.fff" } },
      { status: 200, body: { items: [] } },
    ]);

    await apiRequest("/projects");

    assert.equal(calls.length, 4);
    assert.equal(calls[3]?.headers["Authorization"], "Bearer ddd.eee.fff");
  });

  it("does not retry a configured API key, so one bad key is one error", async () => {
    stubFetch([{ status: 401, body: { code: "E_UNAUTHORIZED", message: "nope" } }]);
    await assert.rejects(() => apiRequest("/projects"), PlankaError);
    assert.equal(calls.length, 1);
  });
});

describe("error mapping", () => {
  const cases: { status: number; body?: unknown; expect: string[] }[] = [
    {
      status: 400,
      body: { code: "E_MISSING_OR_INVALID_PARAMS", problems: ['"name" is required.'] },
      expect: ["400", '"name" is required.'],
    },
    { status: 401, body: { message: "Access token is missing" }, expect: ["PLANKA_TOKEN"] },
    { status: 403, expect: ["viewer on this board", "editor"] },
    { status: 404, expect: ["planka_describe_board", "/api/cards/42"] },
    { status: 422, expect: ["another board"] },
    { status: 429, expect: ["Retry"] },
    { status: 500, expect: ["HTTP 500", "Planka server logs"] },
  ];

  for (const testCase of cases) {
    it(`turns ${testCase.status} into an actionable message`, async () => {
      stubFetch([{ status: testCase.status, body: testCase.body ?? { message: "boom" } }]);
      const error = await apiRequest("/cards/42").catch((thrown: unknown) => thrown);
      assert.ok(error instanceof PlankaError);
      assert.equal(error.status, testCase.status);
      const text = formatError(error);
      for (const fragment of testCase.expect) {
        assert.ok(text.includes(fragment), `expected "${text}" to contain "${fragment}"`);
      }
    });
  }

  it("explains a non-JSON body instead of leaking a parse error", async () => {
    mock.method(globalThis, "fetch", async () => new Response("<html>nginx</html>", { status: 200 }));
    const error = await apiRequest("/projects").catch((thrown: unknown) => thrown);
    assert.ok(error instanceof PlankaError);
    assert.match(formatError(error), /PLANKA_BASE_URL may point at something other than a Planka API/);
  });

  it("names the host when DNS fails", async () => {
    mock.method(globalThis, "fetch", async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    });
    const error = await apiRequest("/projects").catch((thrown: unknown) => thrown);
    assert.match(formatError(error), /Cannot resolve planka\.example\.com/);
  });

  it("names the timeout budget when the instance does not answer", async () => {
    mock.method(globalThis, "fetch", async () => {
      throw Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
    });
    const error = await apiRequest("/projects").catch((thrown: unknown) => thrown);
    assert.match(formatError(error), /did not answer within 30s/);
  });
});

describe("request building", () => {
  it("keeps the literal colon in a card-label path unencoded", async () => {
    stubFetch([{ status: 200, body: {} }]);
    await apiRequest("/cards/card-1/card-labels/labelId:label-2", { method: "DELETE" });
    // Percent-encoding the separator would make Planka answer 404.
    assert.equal(calls[0]?.url, "https://planka.example.com/api/cards/card-1/card-labels/labelId:label-2");
  });

  it("drops undefined and empty query parameters", async () => {
    stubFetch([{ status: 200, body: { items: [] } }]);
    await apiRequest("/lists/1/cards", { query: { search: "bug", labelIds: undefined, userIds: "" } });
    assert.equal(calls[0]?.url, "https://planka.example.com/api/lists/1/cards?search=bug");
  });

  it("treats an empty 204 body as an empty object rather than a parse failure", async () => {
    stubFetch([{ status: 204 }]);
    assert.deepEqual(await apiRequest("/tasks/1"), {});
  });
});
