import {
  GraphQLError,
  Kind,
  parse,
  print,
  valueFromASTUntyped,
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type OperationDefinitionNode,
  type OperationTypeNode,
  type SelectionSetNode,
} from 'graphql';

/**
 * Generic inspection of GraphQL-over-HTTP requests, for tools whose API is a single GraphQL
 * endpoint (the path says nothing, so authorization has to read the document).
 */

/** Bounds parsing work on hostile documents; far above what real clients send. */
const MAX_TOKENS = 20_000;
/**
 * Bounds fragment expansion: spreads can multiply fields (or cycle through nested selections)
 * far beyond the document's size.
 */
const MAX_EXPANDED_FIELDS = 20_000;

export type Args = Record<string, unknown>;

export interface NestedField {
  name: string;
  args: Args;
  /** True when the field selects sub-fields, i.e. it returns an object (a traversal). */
  hasSelection: boolean;
}

export interface RootField {
  operation: OperationTypeNode;
  name: string;
  /** Argument values, with variables (and their declared defaults) substituted. */
  args: Args;
  /** Every field selected below this one, at any depth, fragments expanded. */
  nested: NestedField[];
}

export interface InspectedRequest {
  rootFields: RootField[];
  /** Canonical JSON body to send upstream: exactly what was inspected. */
  body: Buffer;
}

export class GraphQLRequestError extends Error {}

/**
 * Parses a `{ query, variables, operationName }` JSON body. Every operation in the document is
 * inspected (not only the one `operationName` selects), so a grant must cover all of them.
 */
export function inspectGraphQLRequest(raw: Buffer | undefined): InspectedRequest {
  const { query, variables, operationName } = readEnvelope(raw);
  let document: DocumentNode;
  try {
    document = parse(query, { maxTokens: MAX_TOKENS, noLocation: true });
  } catch (err) {
    throw new GraphQLRequestError(
      `Invalid GraphQL document: ${err instanceof GraphQLError ? err.message : 'parse error'}`,
    );
  }
  const operations: OperationDefinitionNode[] = [];
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const def of document.definitions) {
    if (def.kind === Kind.OPERATION_DEFINITION) operations.push(def);
    else if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def);
    else throw new GraphQLRequestError('Only operations and fragments are allowed');
  }
  if (operations.length === 0) throw new GraphQLRequestError('The document has no operation');

  const walk: Walk = { fragments, budget: MAX_EXPANDED_FIELDS };
  const rootFields = operations.flatMap((op) =>
    collectRootFields(op, withDefaults(op, variables), walk),
  );
  const envelope: Record<string, unknown> = { query: print(document), variables };
  if (operationName !== undefined) envelope.operationName = operationName;
  return { rootFields, body: Buffer.from(JSON.stringify(envelope)) };
}

function readEnvelope(raw: Buffer | undefined): {
  query: string;
  variables: Args;
  operationName: string | undefined;
} {
  let json: unknown;
  try {
    json = raw ? JSON.parse(raw.toString('utf8')) : undefined;
  } catch {
    throw new GraphQLRequestError('The body must be JSON: { "query": "…", "variables": { … } }');
  }
  if (!isRecord(json)) {
    throw new GraphQLRequestError('The body must be a single JSON object (no batching)');
  }
  const { query, variables, operationName } = json;
  if (typeof query !== 'string') throw new GraphQLRequestError('"query" must be a string');
  if (variables !== undefined && variables !== null && !isRecord(variables)) {
    throw new GraphQLRequestError('"variables" must be an object');
  }
  if (operationName !== undefined && operationName !== null && typeof operationName !== 'string') {
    throw new GraphQLRequestError('"operationName" must be a string');
  }
  return { query, variables: variables ?? {}, operationName: operationName ?? undefined };
}

/** Variables as the server will see them: provided values, else the declared defaults. */
function withDefaults(op: OperationDefinitionNode, provided: Args): Args {
  const vars: Args = { ...provided };
  for (const def of op.variableDefinitions ?? []) {
    const name = def.variable.name.value;
    if (!(name in vars) && def.defaultValue) {
      vars[name] = valueFromASTUntyped(def.defaultValue);
    }
  }
  return vars;
}

function argsOf(field: FieldNode, vars: Args): Args {
  const args: Args = {};
  for (const arg of field.arguments ?? []) {
    args[arg.name.value] = valueFromASTUntyped(arg.value, vars);
  }
  return args;
}

interface Walk {
  fragments: ReadonlyMap<string, FragmentDefinitionNode>;
  /** Fields left before the document is rejected as too large. */
  budget: number;
}

/** Fields of a selection set with fragment spreads and inline fragments flattened. */
function fieldsOf(set: SelectionSetNode, walk: Walk, stack: string[] = []): FieldNode[] {
  const out: FieldNode[] = [];
  for (const sel of set.selections) {
    if (sel.kind === Kind.FIELD) {
      walk.budget -= 1;
      if (walk.budget < 0) throw new GraphQLRequestError('The document expands to too many fields');
      out.push(sel);
    } else if (sel.kind === Kind.INLINE_FRAGMENT) {
      out.push(...fieldsOf(sel.selectionSet, walk, stack));
    } else {
      const name = sel.name.value;
      const fragment = walk.fragments.get(name);
      if (!fragment) throw new GraphQLRequestError(`Unknown fragment "${name}"`);
      if (stack.includes(name)) throw new GraphQLRequestError(`Fragment "${name}" is cyclic`);
      out.push(...fieldsOf(fragment.selectionSet, walk, [...stack, name]));
    }
  }
  return out;
}

function collectRootFields(op: OperationDefinitionNode, vars: Args, walk: Walk) {
  return fieldsOf(op.selectionSet, walk).map((field): RootField => ({
    operation: op.operation,
    name: field.name.value,
    args: argsOf(field, vars),
    nested: field.selectionSet ? collectNested(field.selectionSet, vars, walk) : [],
  }));
}

function collectNested(set: SelectionSetNode, vars: Args, walk: Walk): NestedField[] {
  const out: NestedField[] = [];
  const pending: SelectionSetNode[] = [set];
  for (let next = pending.pop(); next; next = pending.pop()) {
    for (const field of fieldsOf(next, walk)) {
      out.push({
        name: field.name.value,
        args: argsOf(field, vars),
        hasSelection: field.selectionSet !== undefined,
      });
      if (field.selectionSet) pending.push(field.selectionSet);
    }
  }
  return out;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
