import { randomId } from '../../store/crypto.js';
import { MS_PER_SECOND } from '../../units.js';
import { isRecord } from '../json.js';
import { Denied } from './common.js';

/**
 * Serves the OpenAI Responses API on top of an endpoint that only speaks Chat Completions (most
 * self-hosted servers): Codex only speaks Responses. Requests are rewritten to Chat Completions
 * (then checked like any chat call), and answers, streamed or not, are rewritten back.
 *
 * Covered: text and image input, instructions, function tools and calls, freeform (`custom`)
 * tools as functions taking `{ input }`, tool choice, structured output, usage. Not covered:
 * hosted tools (denied), tool namespaces (dropped: Codex's sub-agent tools), reasoning items
 * (dropped: chat servers keep no encrypted reasoning to hand back).
 */

type Json = Record<string, unknown>;

export interface BridgedRequest {
  /** The Chat Completions body to check and send upstream. */
  chat: Json;
  /** Freeform tools, declared upstream as functions: their calls go back as `custom_tool_call`. */
  customTools: ReadonlySet<string>;
}

const SYSTEM_ROLES = new Set(['system', 'developer']);
const TEXT_PARTS = new Set(['input_text', 'output_text', 'text', 'refusal']);
const NAMESPACE_TOOL = 'namespace';
const CUSTOM_TOOL = 'custom';
const FUNCTION_TOOL = 'function';
const FUNCTION_CALL = 'function_call';
const CUSTOM_TOOL_CALL = 'custom_tool_call';
const ASSISTANT = 'assistant';
const COMPLETED = 'completed';
const SSE_TYPE = 'text/event-stream';
const JSON_TYPE = 'application/json';
/** Copied as-is from a Responses request to its Chat Completions form. */
const PASSTHROUGH = ['model', 'temperature', 'top_p', 'parallel_tool_calls', 'user'] as const;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const records = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isRecord) : []);

// ------------------------------------------------------------------ request

/** A message's content: plain text when it is only text, else chat content parts. */
function chatContent(content: unknown): string | Json[] {
  if (typeof content === 'string') return content;
  const parts = records(content);
  if (parts.every((p) => TEXT_PARTS.has(str(p.type) ?? ''))) {
    return parts.map((p) => str(p.text) ?? str(p.refusal) ?? '').join('');
  }
  return parts.flatMap((p): Json[] => {
    if (p.type === 'input_image') {
      const url = str(p.image_url);
      return url ? [{ type: 'image_url', image_url: { url, detail: p.detail ?? 'auto' } }] : [];
    }
    const text = str(p.text) ?? str(p.refusal);
    return text === undefined ? [] : [{ type: 'text', text }];
  });
}

/** Text of a tool output: a string, or content parts. */
function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  const content = chatContent(output);
  return typeof content === 'string' ? content : JSON.stringify(output);
}

const textOf = (content: string | Json[]): string =>
  typeof content === 'string' ? content : content.map((p) => str(p.text) ?? '').join('');

/** Folds Responses input items into chat messages; system text is gathered apart. */
class MessageBuilder {
  readonly system: string[] = [];
  readonly messages: Json[] = [];

  add(item: Json): void {
    const type = str(item.type) ?? 'message';
    if (type === 'message') this.message(item);
    else if (type === FUNCTION_CALL) this.toolCall(item, str(item.arguments) ?? '{}');
    else if (type === CUSTOM_TOOL_CALL) {
      this.toolCall(item, JSON.stringify({ input: str(item.input) ?? '' }));
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      this.messages.push({
        role: 'tool',
        tool_call_id: str(item.call_id) ?? '',
        content: outputText(item.output),
      });
    }
    // Reasoning and other items have no Chat Completions form.
  }

  private message(item: Json): void {
    const role = str(item.role) ?? 'user';
    const content = chatContent(item.content);
    if (SYSTEM_ROLES.has(role)) this.system.push(textOf(content));
    else if (role === ASSISTANT) this.assistant().content = textOf(content);
    else this.messages.push({ role, content });
  }

  private toolCall(item: Json, args: string): void {
    const message = this.assistant();
    const calls = Array.isArray(message.tool_calls) ? (message.tool_calls as Json[]) : [];
    calls.push({
      id: str(item.call_id) ?? '',
      type: FUNCTION_TOOL,
      function: { name: str(item.name) ?? '', arguments: args },
    });
    message.tool_calls = calls;
  }

  /** The assistant turn being built: text and tool calls of one turn share a message. */
  private assistant(): Json {
    const last = this.messages.at(-1);
    if (last?.role === ASSISTANT) return last;
    const message: Json = { role: ASSISTANT, content: null };
    this.messages.push(message);
    return message;
  }
}

function chatTool(tool: Json, customTools: Set<string>): Json[] {
  const type = str(tool.type) ?? 'unknown';
  const name = str(tool.name) ?? '';
  if (type === NAMESPACE_TOOL) return [];
  if (type === FUNCTION_TOOL) {
    return [
      {
        type: FUNCTION_TOOL,
        function: {
          name,
          ...(tool.description !== undefined && { description: tool.description }),
          parameters: tool.parameters ?? { type: 'object', properties: {} },
          ...(tool.strict !== undefined && { strict: tool.strict }),
        },
      },
    ];
  }
  if (type === CUSTOM_TOOL) {
    customTools.add(name);
    const format = isRecord(tool.format) ? ` Format: ${JSON.stringify(tool.format)}` : '';
    return [
      {
        type: FUNCTION_TOOL,
        function: {
          name,
          description: `${str(tool.description) ?? ''}${format}`,
          parameters: {
            type: 'object',
            properties: { input: { type: 'string', description: 'The raw tool input.' } },
            required: ['input'],
          },
        },
      },
    ];
  }
  throw new Denied(
    `Tool type "${type}" needs the Responses API, which this custom LLM endpoint does not serve`,
  );
}

function chatToolChoice(choice: unknown): unknown {
  if (typeof choice === 'string') return choice;
  if (isRecord(choice) && str(choice.name)) {
    return { type: FUNCTION_TOOL, function: { name: choice.name } };
  }
  return undefined;
}

function chatResponseFormat(text: unknown): Json | undefined {
  const format = isRecord(text) && isRecord(text.format) ? text.format : null;
  if (format?.type === 'json_object') return { type: 'json_object' };
  if (format?.type !== 'json_schema') return undefined;
  return {
    type: 'json_schema',
    json_schema: {
      name: format.name ?? 'output',
      schema: format.schema,
      ...(format.strict !== undefined && { strict: format.strict }),
    },
  };
}

/** The Chat Completions form of a Responses request. */
export function chatRequestOf(body: Json): BridgedRequest {
  const builder = new MessageBuilder();
  const instructions = str(body.instructions);
  if (instructions) builder.system.push(instructions);
  if (typeof body.input === 'string') builder.add({ role: 'user', content: body.input });
  else for (const item of records(body.input)) builder.add(item);

  const customTools = new Set<string>();
  const tools = records(body.tools).flatMap((t) => chatTool(t, customTools));
  const chat: Json = {};
  for (const key of PASSTHROUGH) if (body[key] !== undefined) chat[key] = body[key];
  // Many chat templates take one system message, first.
  const system = builder.system.filter((s) => s !== '').join('\n\n');
  chat.messages = [...(system ? [{ role: 'system', content: system }] : []), ...builder.messages];
  if (tools.length > 0) chat.tools = tools;
  const toolChoice = chatToolChoice(body.tool_choice);
  if (tools.length > 0 && toolChoice !== undefined) chat.tool_choice = toolChoice;
  const responseFormat = chatResponseFormat(body.text);
  if (responseFormat) chat.response_format = responseFormat;
  if (typeof body.max_output_tokens === 'number') chat.max_tokens = body.max_output_tokens;
  if (body.stream === true) chat.stream = true;
  return { chat, customTools };
}

// ------------------------------------------------------------------ response

interface ToolCallDraft {
  callId: string;
  name: string;
  arguments: string;
}

/** Responses usage from Chat Completions usage. */
function responsesUsage(usage: unknown): Json | null {
  if (!isRecord(usage)) return null;
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  const input = num(usage.prompt_tokens);
  const output = num(usage.completion_tokens);
  const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const reasoning = isRecord(usage.completion_tokens_details)
    ? num(usage.completion_tokens_details.reasoning_tokens)
    : 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: num(details.cached_tokens) },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: reasoning },
    total_tokens: num(usage.total_tokens) || input + output,
  };
}

/** Collects one answer's output items and builds the Responses `response` object. */
class ResponseDraft {
  readonly id = `resp_${randomId()}`;
  readonly createdAt = Math.floor(Date.now() / MS_PER_SECOND);
  text = '';
  textItemId: string | null = null;
  readonly calls = new Map<number, ToolCallDraft>();
  usage: Json | null = null;
  finishReason: string | null = null;
  private items = 0;

  constructor(
    readonly model: string,
    private readonly customTools: ReadonlySet<string>,
  ) {}

  nextItemId(prefix: string): string {
    this.items += 1;
    return `${prefix}_${this.id.slice('resp_'.length)}_${String(this.items)}`;
  }

  messageItem(status: string): Json {
    return {
      type: 'message',
      id: this.textItemId,
      role: ASSISTANT,
      status,
      content: status === COMPLETED ? [this.textPart()] : [],
    };
  }

  textPart(): Json {
    return { type: 'output_text', text: this.text, annotations: [] };
  }

  callItem(call: ToolCallDraft, id: string): Json {
    if (this.customTools.has(call.name)) {
      let input = call.arguments;
      try {
        const parsed: unknown = JSON.parse(call.arguments);
        if (isRecord(parsed) && typeof parsed.input === 'string') input = parsed.input;
      } catch {
        // Not the `{ input }` object it was declared with: hand over the raw arguments.
      }
      return {
        type: CUSTOM_TOOL_CALL,
        id,
        call_id: call.callId,
        name: call.name,
        input,
        status: COMPLETED,
      };
    }
    return {
      type: FUNCTION_CALL,
      id,
      call_id: call.callId,
      name: call.name,
      arguments: call.arguments,
      status: COMPLETED,
    };
  }

  response(status: string, output: Json[]): Json {
    const incomplete = this.finishReason === 'length';
    const final = status === COMPLETED && incomplete ? 'incomplete' : status;
    return {
      id: this.id,
      object: 'response',
      created_at: this.createdAt,
      status: final,
      model: this.model,
      output,
      usage: this.usage,
      ...(final === 'incomplete' && { incomplete_details: { reason: 'max_output_tokens' } }),
    };
  }
}

function addChoice(draft: ResponseDraft, message: Json): void {
  draft.text += str(message.content) ?? '';
  for (const [i, call] of records(message.tool_calls).entries()) {
    const fn = isRecord(call.function) ? call.function : {};
    const index = typeof call.index === 'number' ? call.index : i;
    const known = draft.calls.get(index);
    if (known) {
      known.arguments += str(fn.arguments) ?? '';
      if (!known.name) known.name = str(fn.name) ?? '';
    } else {
      draft.calls.set(index, {
        callId: str(call.id) ?? `call_${draft.id}_${String(index)}`,
        name: str(fn.name) ?? '',
        arguments: str(fn.arguments) ?? '',
      });
    }
  }
}

/** A complete (non-streamed) chat completion as a Responses `response`. */
function responseOfCompletion(completion: unknown, draft: ResponseDraft): Json {
  const choice = isRecord(completion) ? records(completion.choices)[0] : undefined;
  if (choice && isRecord(choice.message)) addChoice(draft, choice.message);
  draft.finishReason = str(choice?.finish_reason) ?? null;
  draft.usage = isRecord(completion) ? responsesUsage(completion.usage) : null;
  const output: Json[] = [];
  if (draft.text) {
    draft.textItemId = draft.nextItemId('msg');
    output.push(draft.messageItem(COMPLETED));
  }
  for (const call of draft.calls.values())
    output.push(draft.callItem(call, draft.nextItemId('fc')));
  return draft.response(COMPLETED, output);
}

/** Turns a Chat Completions SSE stream into Responses SSE events. */
class StreamTranslator {
  private sequence = 0;
  private readonly output: Json[] = [];
  private textIndex = -1;
  private done = false;

  constructor(
    private readonly draft: ResponseDraft,
    private readonly emit: (event: Json) => void,
  ) {}

  start(): void {
    const response = this.draft.response('in_progress', []);
    this.send('response.created', { response });
    this.send('response.in_progress', { response });
  }

  chunk(data: string): void {
    if (this.done || data.trim() === '[DONE]') return;
    let chunk: unknown;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(chunk)) return;
    if (isRecord(chunk.error)) {
      this.fail(str(chunk.error.message) ?? 'The custom LLM endpoint failed');
      return;
    }
    const usage = responsesUsage(chunk.usage);
    if (usage) this.draft.usage = usage;
    const choice = records(chunk.choices)[0];
    if (!choice) return;
    if (isRecord(choice.delta)) this.delta(choice.delta);
    if (str(choice.finish_reason)) this.draft.finishReason = str(choice.finish_reason) ?? null;
  }

  finish(): void {
    if (this.done) return;
    this.done = true;
    this.closeText();
    for (const call of this.draft.calls.values()) {
      const item = this.draft.callItem(call, this.draft.nextItemId('fc'));
      const outputIndex = this.output.length;
      this.output.push(item);
      this.send('response.output_item.added', { output_index: outputIndex, item });
      this.send('response.output_item.done', { output_index: outputIndex, item });
    }
    const response = this.draft.response(COMPLETED, this.output);
    this.send(response.status === COMPLETED ? 'response.completed' : 'response.incomplete', {
      response,
    });
  }

  private fail(message: string): void {
    this.done = true;
    const response = {
      ...this.draft.response('failed', this.output),
      error: { code: 'server_error', message },
    };
    this.send('response.failed', { response });
  }

  private delta(delta: Json): void {
    const text = str(delta.content);
    if (text) this.textDelta(text);
    addChoice(this.draft, { tool_calls: delta.tool_calls });
  }

  private textDelta(text: string): void {
    if (this.textIndex < 0) {
      this.draft.textItemId = this.draft.nextItemId('msg');
      this.textIndex = this.output.length;
      this.output.push({});
      this.send('response.output_item.added', {
        output_index: this.textIndex,
        item: this.draft.messageItem('in_progress'),
      });
      this.send('response.content_part.added', {
        ...this.textRef(),
        part: { type: 'output_text', text: '', annotations: [] },
      });
    }
    this.draft.text += text;
    this.send('response.output_text.delta', { ...this.textRef(), delta: text });
  }

  private closeText(): void {
    if (this.textIndex < 0) return;
    const item = this.draft.messageItem(COMPLETED);
    this.output[this.textIndex] = item;
    this.send('response.output_text.done', { ...this.textRef(), text: this.draft.text });
    this.send('response.content_part.done', { ...this.textRef(), part: this.draft.textPart() });
    this.send('response.output_item.done', { output_index: this.textIndex, item });
  }

  private textRef(): Json {
    return { item_id: this.draft.textItemId, output_index: this.textIndex, content_index: 0 };
  }

  private send(type: string, fields: Json): void {
    this.sequence += 1;
    this.emit({ type, sequence_number: this.sequence, ...fields });
  }
}

/** Splits SSE bytes into `data:` payloads. */
function sseTransform(translator: (emit: (event: Json) => void) => StreamTranslator) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = '';
  let data: string[] = [];
  let t: StreamTranslator | null = null;
  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      t = translator((event) => {
        controller.enqueue(
          encoder.encode(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`),
        );
      });
      t.start();
    },
    transform(chunk) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (line === '' && data.length > 0) {
          t?.chunk(data.join('\n'));
          data = [];
        } else if (line.startsWith('data:')) {
          data.push(line.slice('data:'.length).trimStart());
        }
      }
    },
    flush() {
      if (pending.startsWith('data:')) data.push(pending.slice('data:'.length).trimStart());
      if (data.length > 0) t?.chunk(data.join('\n'));
      t?.finish();
    },
  });
}

function withBody(
  upstream: Response,
  body: ReadableStream<Uint8Array> | string,
  contentType: string,
): Response {
  const headers = new Headers(upstream.headers);
  headers.delete('content-length');
  headers.set('content-type', contentType);
  return new Response(body, { status: upstream.status, headers });
}

/**
 * The Responses form of an upstream Chat Completions answer. Errors pass through unchanged: they
 * already say what went wrong, in the shape OpenAI clients read.
 */
export async function responsesAnswer(
  upstream: Response,
  model: string,
  customTools: ReadonlySet<string>,
): Promise<Response> {
  const contentType = upstream.headers.get('content-type') ?? '';
  if (!upstream.ok || !upstream.body) return upstream;
  const draft = new ResponseDraft(model, customTools);
  if (contentType.includes(SSE_TYPE)) {
    const stream = upstream.body.pipeThrough(
      sseTransform((emit) => new StreamTranslator(draft, emit)),
    );
    return withBody(upstream, stream, SSE_TYPE);
  }
  const completion: unknown = await upstream.json().catch(() => null);
  return withBody(upstream, JSON.stringify(responseOfCompletion(completion, draft)), JSON_TYPE);
}
