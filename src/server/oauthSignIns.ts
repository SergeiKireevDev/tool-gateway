import { z } from 'zod';
import { badGateway, badRequest, notFound } from './errors.js';
import type { Actor, Gateway, PublicAccount } from './gateway.js';
import { pkcePair, randomToken } from './store/crypto.js';
import { MS_PER_MINUTE } from './units.js';

const FLOW_TTL_MINUTES = 10;
const FLOW_ID_BYTES = 16;
const MAX_LABEL_LENGTH = 100;
const MAX_INPUT_LENGTH = 4096;
const SIGN_IN_NOT_FOUND = 'Unknown or expired sign-in: start again';

export const signInStartSchema = z.object({
  tool: z.string().min(1),
  label: z.string().trim().min(1).max(MAX_LABEL_LENGTH),
});

export const signInCompleteSchema = z.object({
  /** The redirect URL the browser landed on, `code#state`, or the bare code. */
  input: z.string().trim().min(1).max(MAX_INPUT_LENGTH),
});

interface PendingSignIn {
  ownerMemberId: string | null;
  tool: string;
  label: string;
  verifier: string;
  state: string;
  expiresAt: number;
}

/** Reads the code (and state, when present) from what the user pasted back. */
export function parseAuthorizationInput(input: string): { code: string; state: string | null } {
  const text = input.trim();
  const fromParams = (params: URLSearchParams): { code: string; state: string | null } | null => {
    const code = params.get('code');
    return code ? { code, state: params.get('state') } : null;
  };
  if (URL.canParse(text)) {
    const parsed = fromParams(new URL(text).searchParams);
    if (parsed) return parsed;
  }
  if (text.includes('code=')) {
    const parsed = fromParams(new URLSearchParams(text.replace(/^\?/, '')));
    if (parsed) return parsed;
  }
  const [code = '', state] = text.split('#');
  if (!code) throw badRequest('Paste the address of the page you landed on, or the code');
  return { code, state: state ?? null };
}

/**
 * "Sign in with …" through OAuth (authorization code + PKCE). The redirect lands on the user's own
 * machine, so they paste its address back; the tokens become an account owned by whoever signed
 * in (a member's own account, or a shared one for the admin), stored encrypted like any other.
 */
export class OAuthSignIns {
  private readonly flows = new Map<string, PendingSignIn>();

  constructor(
    private readonly gateway: Gateway,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async start(
    input: unknown,
    actor: Actor,
  ): Promise<{ flowId: string; authorizeUrl: string; help: string; expiresAt: string }> {
    const data = signInStartSchema.parse(input);
    const tool = this.gateway.tools.get(data.tool);
    if (!tool?.oauthSignIn) throw badRequest(`"${data.tool}" has no sign-in`);
    this.prune();
    const { verifier, challenge } = await pkcePair();
    // Like Claude Code, the PKCE verifier doubles as the state.
    const state = verifier;
    const flowId = randomToken('', FLOW_ID_BYTES);
    const expiresAt = this.now().getTime() + FLOW_TTL_MINUTES * MS_PER_MINUTE;
    this.flows.set(flowId, {
      ownerMemberId: actor.kind === 'member' ? actor.member.id : null,
      tool: tool.id,
      label: data.label,
      verifier,
      state,
      expiresAt,
    });
    return {
      flowId,
      authorizeUrl: tool.oauthSignIn.authorizeUrl(challenge, state),
      help: tool.oauthSignIn.help,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  async complete(flowId: string, input: unknown, actor: Actor): Promise<PublicAccount> {
    const flow = this.flow(flowId, actor);
    const { code, state } = parseAuthorizationInput(signInCompleteSchema.parse(input).input);
    if (state !== null && state !== flow.state) {
      throw badRequest('This address belongs to another sign-in: start again');
    }
    const signIn = this.gateway.tools.get(flow.tool)?.oauthSignIn;
    if (!signIn) throw notFound(SIGN_IN_NOT_FOUND);
    this.flows.delete(flowId);
    let tokens;
    try {
      tokens = await signIn.exchange(code, flow.state, flow.verifier);
    } catch (err) {
      throw badGateway((err as Error).message);
    }
    return this.gateway.addOAuthAccount(flow.tool, flow.label, tokens, actor);
  }

  cancel(flowId: string, actor: Actor): void {
    this.flow(flowId, actor);
    this.flows.delete(flowId);
  }

  /** A sign-in can only be completed or cancelled by whoever started it. */
  private flow(flowId: string, actor: Actor): PendingSignIn {
    const flow = this.flows.get(flowId);
    const owner = actor.kind === 'member' ? actor.member.id : null;
    if (flow?.ownerMemberId !== owner || flow.expiresAt <= this.now().getTime()) {
      throw notFound(SIGN_IN_NOT_FOUND);
    }
    return flow;
  }

  private prune(): void {
    const now = this.now().getTime();
    for (const [id, flow] of this.flows) if (flow.expiresAt <= now) this.flows.delete(id);
  }
}
