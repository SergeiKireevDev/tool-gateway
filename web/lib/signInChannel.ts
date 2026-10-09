/**
 * When a provider redirects back to the gateway after "Sign in with …", the callback page (in the
 * sign-in window) hands the address to the dialog that started the sign-in, in the original tab.
 * The dialog completes the sign-in with its own credentials (admin token or session cookie).
 */
const CHANNEL = 'gateway.sign-in';

export type SignInMessage =
  /** Callback page → dialogs: the address Google redirected to. */
  | { kind: 'redirect'; url: string }
  /** Dialog → callback page: the sign-in with this state is its own, and is being completed. */
  | { kind: 'received'; state: string };

const isMessage = (data: unknown): data is SignInMessage =>
  typeof data === 'object' &&
  data !== null &&
  'kind' in data &&
  ((data.kind === 'redirect' && 'url' in data && typeof data.url === 'string') ||
    (data.kind === 'received' && 'state' in data && typeof data.state === 'string'));

/** Listens on the channel; returns a function that posts to it, and one that closes it. */
export function openSignInChannel(onMessage: (message: SignInMessage) => void): {
  post: (message: SignInMessage) => void;
  close: () => void;
} {
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event: MessageEvent<unknown>) => {
    if (isMessage(event.data)) onMessage(event.data);
  };
  return {
    post: (message) => {
      channel.postMessage(message);
    },
    close: () => {
      channel.close();
    },
  };
}

/** The `state` parameter of an authorize or redirect address. */
export const stateOf = (url: string): string | null =>
  URL.canParse(url) ? new URL(url).searchParams.get('state') : null;
