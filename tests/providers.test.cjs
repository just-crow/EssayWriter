const { test } = require('node:test');
const assert = require('node:assert/strict');
const { z } = require('zod');
const { nimChat, nimChatLong, completeJson, nimClient, openRouterClient, tagProviderError, resetProviderCooldowns, NIM_MODEL, OPENROUTER_MODEL } = require('../lib/nim.ts');

test('OpenRouter primary, transport fallback, cooldown and JSON repair', async () => {
  const oldRouterKey = process.env.OPENROUTER_API_KEY;
  const oldNvidiaKey = process.env.NVIDIA_NIM_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-router-key';
  process.env.NVIDIA_NIM_API_KEY = 'test-nvidia-key';
  const router = openRouterClient().chat.completions;
  const nvidia = nimClient().chat.completions;
  const oldRouter = router.create, oldNvidia = nvidia.create, oldNow = Date.now;
  let now = oldNow(), routerCalls = 0, nvidiaCalls = 0;
  Date.now = () => now;
  const response = content => ({ choices: [{ finish_reason: 'stop', message: { content } }] });
  const params = { system: 'Return JSON.', user: 'Return an ok boolean.', tries: 1, thinking: false };
  try {
    router.create = async body => {
      routerCalls++;
      assert.equal(body.model, OPENROUTER_MODEL);
      assert.equal(body.response_format.type, 'json_schema');
      assert.equal(body.response_format.json_schema.strict, true);
      assert.deepEqual(body.provider, { require_parameters: true });
      assert.deepEqual(body.reasoning, { effort: 'none', exclude: true });
      return response('{"ok":true}');
    };
    nvidia.create = async body => { nvidiaCalls++; assert.equal(body.model, NIM_MODEL); return response('{"ok":true}'); };
    assert.deepEqual(await completeJson({ ...params, schema: z.object({ ok: z.boolean() }) }), { ok: true });
    assert.equal(nvidiaCalls, 0);

    router.create = async body => {
      routerCalls++;
      assert.equal(body.model, 'openai/gpt-6-luna');
      assert.equal(body.response_format.type, 'json_object');
      assert.equal('provider' in body, false);
      return response('{"ok":true}');
    };
    assert.equal(await nimChat({ ...params, responseFormat: { type: 'json_object' } }), '{"ok":true}');
    assert.equal(nvidiaCalls, 0);

    router.create = async body => {
      routerCalls++;
      assert.equal(body.model, 'openai/gpt-6-luna');
      assert.deepEqual(body.reasoning, { effort: 'low', exclude: true });
      assert.equal('temperature' in body, false);
      assert.equal('top_p' in body, false);
      return response('{"ok":true}');
    };
    assert.equal(await nimChat({ ...params, thinking: true, lowEffort: true, reasoningBudget: 256 }), '{"ok":true}');

    const providers = [];
    router.create = async () => { routerCalls++; throw Object.assign(new Error('Rate limited'), { status: 429 }); };
    assert.equal(await nimChat({ ...params, onProvider: p => providers.push(p) }), '{"ok":true}');
    assert.deepEqual(providers, ['openrouter', 'nvidia']);
    const callsBeforeCooldown = routerCalls;
    await nimChat(params);
    assert.equal(routerCalls, callsBeforeCooldown);

    now += 61_000;
    router.create = async () => { routerCalls++; return response('invalid JSON'); };
    nvidia.create = async body => {
      nvidiaCalls++;
      assert.equal(body.response_format.type, 'json_schema');
      return response('{"ok":true}');
    };
    const beforeRepair = routerCalls;
    assert.deepEqual(await completeJson({ ...params, schema: z.object({ ok: z.boolean() }) }), { ok: true });
    assert.equal(routerCalls, beforeRepair + 1);

    router.create = async function* () {
      yield { choices: [{ delta: { content: 'partial garbage' } }] };
      throw new Error('stream disconnected');
    };
    nvidia.create = async function* () {
      yield { choices: [{ delta: { content: '{"ok":true}' }, finish_reason: 'stop' }] };
    };
    assert.equal(await nimChatLong(params), '{"ok":true}');
  } finally {
    router.create = oldRouter; nvidia.create = oldNvidia; Date.now = oldNow;
    if (oldRouterKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldRouterKey;
    if (oldNvidiaKey === undefined) delete process.env.NVIDIA_NIM_API_KEY; else process.env.NVIDIA_NIM_API_KEY = oldNvidiaKey;
  }
});

test('paid primary is retried before any fallback', async () => {
  const oldRouterKey = process.env.OPENROUTER_API_KEY;
  const oldNvidiaKey = process.env.NVIDIA_NIM_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-router-key';
  process.env.NVIDIA_NIM_API_KEY = 'test-nvidia-key';
  const router = openRouterClient().chat.completions;
  const nvidia = nimClient().chat.completions;
  const oldRouter = router.create, oldNvidia = nvidia.create;
  const response = content => ({ choices: [{ finish_reason: 'stop', message: { content } }] });
  const params = { system: 'Return JSON.', user: 'hi', tries: 2, thinking: false };
  let routerCalls = 0, nvidiaCalls = 0;
  resetProviderCooldowns();
  try {
    router.create = async () => { routerCalls++; if (routerCalls === 1) throw Object.assign(new Error('Service temporarily overloaded'), { status: 503 }); return response('{"ok":true}'); };
    nvidia.create = async () => { nvidiaCalls++; return response('{"ok":true}'); };
    assert.equal(await nimChat(params), '{"ok":true}');
    assert.equal(routerCalls, 2);
    assert.equal(nvidiaCalls, 0);
  } finally {
    router.create = oldRouter; nvidia.create = oldNvidia;
    if (oldRouterKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldRouterKey;
    if (oldNvidiaKey === undefined) delete process.env.NVIDIA_NIM_API_KEY; else process.env.NVIDIA_NIM_API_KEY = oldNvidiaKey;
  }
});

test('dual provider failure names both providers', async () => {
  const oldRouterKey = process.env.OPENROUTER_API_KEY;
  const oldNvidiaKey = process.env.NVIDIA_NIM_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-router-key';
  process.env.NVIDIA_NIM_API_KEY = 'test-nvidia-key';
  const router = openRouterClient().chat.completions;
  const nvidia = nimClient().chat.completions;
  const oldRouter = router.create, oldNvidia = nvidia.create;
  const params = { system: 'Return JSON.', user: 'hi', tries: 1, thinking: false };
  resetProviderCooldowns();
  try {
    router.create = async () => { throw Object.assign(new Error('Service temporarily overloaded'), { status: 503 }); };
    nvidia.create = async () => { throw Object.assign(new Error('Service temporarily overloaded'), { status: 503 }); };
    await assert.rejects(nimChat(params), /OpenRouter Luna error \(503\).*NVIDIA fallback failed: NVIDIA error \(503\)/);
  } finally {
    router.create = oldRouter; nvidia.create = oldNvidia;
    if (oldRouterKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldRouterKey;
    if (oldNvidiaKey === undefined) delete process.env.NVIDIA_NIM_API_KEY; else process.env.NVIDIA_NIM_API_KEY = oldNvidiaKey;
  }
});

test('rate-limit hint survives provider tagging', async () => {
  const oldRouterKey = process.env.OPENROUTER_API_KEY;
  const oldNvidiaKey = process.env.NVIDIA_NIM_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-router-key';
  process.env.NVIDIA_NIM_API_KEY = 'test-nvidia-key';
  const router = openRouterClient().chat.completions;
  const nvidia = nimClient().chat.completions;
  const oldRouter = router.create, oldNvidia = nvidia.create;
  const params = { system: 'Return JSON.', user: 'hi', tries: 1, thinking: false };
  resetProviderCooldowns();
  try {
    router.create = async () => { throw Object.assign(new Error('Rate limited'), { status: 429, headers: {} }); };
    nvidia.create = async () => { throw Object.assign(new Error('Rate limited'), { status: 429, headers: {} }); };
    await assert.rejects(
      completeJson({ ...params, schema: z.object({ ok: z.boolean() }) }),
      /Rate limit reached \(OpenRouter Luna error \(429\)/
    );
  } finally {
    router.create = oldRouter; nvidia.create = oldNvidia;
    if (oldRouterKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldRouterKey;
    if (oldNvidiaKey === undefined) delete process.env.NVIDIA_NIM_API_KEY; else process.env.NVIDIA_NIM_API_KEY = oldNvidiaKey;
  }
});

test('Luna JSON calls omit sampling params for routability', async () => {
  const oldRouterKey = process.env.OPENROUTER_API_KEY;
  const oldNvidiaKey = process.env.NVIDIA_NIM_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-router-key';
  process.env.NVIDIA_NIM_API_KEY = 'test-nvidia-key';
  const router = openRouterClient().chat.completions;
  const nvidia = nimClient().chat.completions;
  const oldRouter = router.create, oldNvidia = nvidia.create;
  const response = content => ({ choices: [{ finish_reason: 'stop', message: { content } }] });
  resetProviderCooldowns();
  try {
    let seen;
    router.create = async body => { seen = body; return response('{"ok":true}'); };
    // thinking:false + JSON schema: temperature/top_p would 404 routing.
    await nimChat({ system: 's', user: 'u', thinking: false, responseFormat: { type: 'json_schema', json_schema: { name: 't', strict: true, schema: { type: 'object' } } } });
    assert.equal('temperature' in seen, false);
    assert.equal('top_p' in seen, false);
    assert.deepEqual(seen.provider, { require_parameters: true });
    // Plain-text Luna calls keep sampling params (routable, verified live).
    await nimChat({ system: 's', user: 'u', thinking: false, temperature: 0.5 });
    assert.equal(seen.temperature, 0.5);
    assert.equal(seen.top_p, 0.95);
    assert.equal('provider' in seen, false);
  } finally {
    router.create = oldRouter; nvidia.create = oldNvidia;
    if (oldRouterKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldRouterKey;
    if (oldNvidiaKey === undefined) delete process.env.NVIDIA_NIM_API_KEY; else process.env.NVIDIA_NIM_API_KEY = oldNvidiaKey;
  }
});

test('provider tagging leaves logic errors untouched', () => {
  const plain = new Error('Model returned an empty response.');
  assert.equal(tagProviderError('openrouter', plain), plain);
  const http = Object.assign(new Error('overloaded'), { status: 503 });
  const tagged = tagProviderError('openrouter', http);
  assert.match(tagged.message, /OpenRouter Luna error \(503\): overloaded/);
  assert.equal(tagged.status, 503);
});

test('bare upstream failures are tagged and retried', () => {
  // Mid-stream provider failures arrive without HTTP status.
  const bare = new Error('Service temporarily overloaded');
  const tagged = tagProviderError('nvidia', bare);
  assert.match(tagged.message, /NVIDIA error: Service temporarily overloaded/);
  const wrapped = new Error('Model service error (x). Try again in a bit.');
  assert.equal(tagProviderError('openrouter', wrapped), wrapped);
});

test('cancellation stops before any provider request or fallback', async () => {
  const controller=new AbortController();
  controller.abort(new Error('Draft cancelled'));
  await assert.rejects(nimChat({system:'Test',user:'Test',signal:controller.signal}),/Draft cancelled/);
  await assert.rejects(nimChatLong({system:'Test',user:'Test',signal:controller.signal}),/Draft cancelled/);
});
