import { BlockList, isIP } from 'node:net';

/**
 * Domains agents may reach directly over HTTPS (through the gateway's egress proxy), listed per
 * template as patterns: `example.com` (that host only) or `*.example.com` (its subdomains, not
 * the domain itself).
 */

export const MAX_EGRESS_DOMAINS = 100;
const MAX_DOMAIN_LENGTH = 253;
const WILDCARD = '*.';
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** A wildcard must leave at least this many labels (`*.example.com`, never `*.com`). */
const MIN_WILDCARD_LABELS = 2;

/**
 * Services the gateway already brokers with finer checks (per repository, per permission, token
 * budgets). Direct access would bypass them, so neither these domains nor their subdomains can be
 * allowed.
 */
export const MEDIATED_DOMAINS = [
  'github.com',
  'monday.com',
  'slack.com',
  'linear.app',
  'anthropic.com',
  'claude.ai',
  'openai.com',
  'chatgpt.com',
  'generativelanguage.googleapis.com',
] as const;

function isHostname(name: string): boolean {
  if (name.length > MAX_DOMAIN_LENGTH) return false;
  const labels = name.split('.');
  // An all-digit last label would be an IPv4 address, not a domain.
  return (
    labels.length >= 2 &&
    labels.every((l) => LABEL_RE.test(l)) &&
    !/^\d+$/.test(labels.at(-1) ?? '')
  );
}

const coveredBy = (host: string, domain: string): boolean =>
  host === domain || host.endsWith(`.${domain}`);

/** True when the host is a brokered service (or one of its subdomains). */
export function isMediated(host: string): boolean {
  return MEDIATED_DOMAINS.some((m) => coveredBy(host, m));
}

/** Normalizes a domain pattern; returns an error message when it is not acceptable. */
export function checkDomainPattern(input: string): { pattern: string } | { error: string } {
  const pattern = input.trim().toLowerCase().replace(/\.$/, '');
  const wildcard = pattern.startsWith(WILDCARD);
  const base = wildcard ? pattern.slice(WILDCARD.length) : pattern;
  if (!isHostname(base) || (wildcard && base.split('.').length < MIN_WILDCARD_LABELS)) {
    return { error: `"${input}" is not a domain or a "*.domain" pattern` };
  }
  const brokered = MEDIATED_DOMAINS.find(
    (m) => coveredBy(base, m) || (wildcard && coveredBy(m, base)),
  );
  if (brokered) {
    return {
      error: `"${input}" covers ${brokered}, which the gateway brokers: grant its tool instead`,
    };
  }
  return { pattern };
}

/** True when `host` (lower-case) is allowed by one of the patterns. */
export function domainAllowed(host: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => (p.startsWith(WILDCARD) ? host.endsWith(p.slice(1)) : host === p));
}

/** Normalizes a requested host name; null for IP literals and anything that isn't a hostname. */
export function parseHost(host: string): string | null {
  const name = host.toLowerCase().replace(/\.$/, '');
  return isIP(name) === 0 && isHostname(name) ? name : null;
}

const IPV4_MAPPED = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;

/** Addresses no allowed domain may resolve to: private, local, shared, reserved, multicast. */
const NON_PUBLIC_V4 = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
];
const NON_PUBLIC_V6 = [
  '::/128',
  '::1/128',
  '64:ff9b::/96',
  '100::/64',
  '2001::/32',
  '2001:db8::/32',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
];
const IPV4 = 4;

const NON_PUBLIC = (() => {
  const list = new BlockList();
  const add = (cidr: string, type: 'ipv4' | 'ipv6'): void => {
    const [net = '', prefix = ''] = cidr.split('/');
    list.addSubnet(net, Number(prefix), type);
  };
  for (const cidr of NON_PUBLIC_V4) add(cidr, 'ipv4');
  for (const cidr of NON_PUBLIC_V6) add(cidr, 'ipv6');
  return list;
})();

/** True for a public unicast address (IPv4-mapped IPv6 is checked as IPv4). */
export function isPublicAddress(address: string): boolean {
  const mapped = IPV4_MAPPED.exec(address)?.[1];
  const ip = mapped ?? address;
  const family = isIP(ip);
  if (family === 0) return false;
  return !NON_PUBLIC.check(ip, family === IPV4 ? 'ipv4' : 'ipv6');
}
