import { beforeAll, describe, expect, it } from 'vitest';
import sodium from 'libsodium-wrappers';
import { chatRequestOf, responsesAnswer } from '../src/server/tools/llm/responsesBridge.js';

beforeAll(async () => {
  await sodium.ready;
});

type Json = Record<string, unknown>;

const sse = (chunks: (Json | string)[]): Response =>
  new Response(
    chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  );

const delta = (d: Json, finish: string | null = null): Json => ({
  choices: [{ index: 0, delta: d, finish_reason: finish }],
});

async function events(res: Response): Promise<Json[]> {
  return (await res.text())
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice('data: '.length)) as Json);
}

describe('Responses requests as Chat Completions', () => {
  it('turns input items into chat messages', () => {
    const { chat, customTools } = chatRequestOf({
      model: 'qwen3',
      instructions: 'Be brief',
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Rules' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'List files' }] },
        { type: 'reasoning', summary: [] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'On it' }] },
        { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"cmd":"ls"}' },
        { type: 'custom_tool_call', call_id: 'c2', name: 'apply_patch', input: '*** Begin' },
        { type: 'function_call_output', call_id: 'c1', output: 'a b' },
        {
          type: 'custom_tool_call_output',
          call_id: 'c2',
          output: [{ type: 'input_text', text: 'ok' }],
        },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'See' },
            { type: 'input_image', image_url: 'data:image/png;base64,AA' },
          ],
        },
      ],
      tools: [
        { type: 'function', name: 'shell', description: 'Run', parameters: { type: 'object' } },
        { type: 'custom', name: 'apply_patch', description: 'Patch' },
        { type: 'namespace', name: 'agents', tools: [{ type: 'function', name: 'spawn' }] },
      ],
      tool_choice: 'auto',
      text: { format: { type: 'json_schema', name: 'out', schema: { type: 'object' } } },
      max_output_tokens: 500,
      store: false,
      include: ['reasoning.encrypted_content'],
      stream: true,
    });
    expect(chat).toEqual({
      model: 'qwen3',
      messages: [
        { role: 'system', content: 'Be brief\n\nRules' },
        { role: 'user', content: 'List files' },
        {
          role: 'assistant',
          content: 'On it',
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls"}' } },
            {
              id: 'c2',
              type: 'function',
              function: { name: 'apply_patch', arguments: '{"input":"*** Begin"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'a b' },
        { role: 'tool', tool_call_id: 'c2', content: 'ok' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'See' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AA', detail: 'auto' } },
          ],
        },
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'shell', description: 'Run', parameters: { type: 'object' } },
        },
        {
          type: 'function',
          function: {
            name: 'apply_patch',
            description: 'Patch',
            parameters: {
              type: 'object',
              properties: { input: { type: 'string', description: 'The raw tool input.' } },
              required: ['input'],
            },
          },
        },
      ],
      tool_choice: 'auto',
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'out', schema: { type: 'object' } },
      },
      max_tokens: 500,
      stream: true,
    });
    expect([...customTools]).toEqual(['apply_patch']);
  });

  it('takes a plain string input and refuses hosted tools', () => {
    expect(chatRequestOf({ model: 'm', input: 'Hi' }).chat).toEqual({
      model: 'm',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(() =>
      chatRequestOf({ model: 'm', input: 'Hi', tools: [{ type: 'web_search' }] }),
    ).toThrow(/web_search/);
  });
});

describe('Chat Completions answers as Responses', () => {
  it('streams text, then tool calls, then the completed response with usage', async () => {
    const res = await responsesAnswer(
      sse([
        delta({ role: 'assistant', content: 'Let me ' }),
        delta({ content: 'look' }),
        delta({
          tool_calls: [
            { index: 0, id: 'call_a', function: { name: 'shell', arguments: '{"cmd"' } },
          ],
        }),
        delta({ tool_calls: [{ index: 0, function: { arguments: ':"ls"}' } }] }),
        delta({
          tool_calls: [
            {
              index: 1,
              id: 'call_b',
              function: { name: 'apply_patch', arguments: '{"input":"P"}' },
            },
          ],
        }),
        delta({}, 'tool_calls'),
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } },
        '[DONE]',
      ]),
      'qwen3',
      new Set(['apply_patch']),
    );
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const all = await events(res);
    expect(all.map((e) => e.type)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.output_item.added',
      'response.output_item.done',
      'response.output_item.added',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(all.map((e) => e.sequence_number)).toEqual(all.map((_, i) => i + 1));
    const completed = all.at(-1)?.response as Json;
    expect(completed).toMatchObject({
      object: 'response',
      status: 'completed',
      model: 'qwen3',
      usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Let me look' }],
        },
        { type: 'function_call', call_id: 'call_a', name: 'shell', arguments: '{"cmd":"ls"}' },
        { type: 'custom_tool_call', call_id: 'call_b', name: 'apply_patch', input: 'P' },
      ],
    });
  });

  it('reports cut-off answers as incomplete and upstream stream errors as failed', async () => {
    const cut = await events(
      await responsesAnswer(sse([delta({ content: 'Hi' }, 'length')]), 'm', new Set()),
    );
    expect(cut.at(-1)).toMatchObject({
      type: 'response.incomplete',
      response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
    });
    const failed = await events(
      await responsesAnswer(sse([{ error: { message: 'model crashed' } }]), 'm', new Set()),
    );
    expect(failed.at(-1)).toMatchObject({
      type: 'response.failed',
      response: { status: 'failed', error: { message: 'model crashed' } },
    });
  });

  it('converts complete answers and passes errors through', async () => {
    const res = await responsesAnswer(
      Response.json({
        choices: [
          {
            message: {
              content: 'Done',
              tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }),
      'm',
      new Set(),
    );
    expect(await res.json()).toMatchObject({
      status: 'completed',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'Done' }] },
        { type: 'function_call', call_id: 'c', name: 'f', arguments: '{}' },
      ],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    });
    const error = Response.json({ error: { message: 'bad model' } }, { status: 400 });
    expect(await responsesAnswer(error, 'm', new Set())).toBe(error);
  });
});
