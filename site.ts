// Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
// This product includes software developed at Datadog (https://www.datadoghq.com/) Copyright 2026 Datadog, Inc.

// Datadog site resolution — pure, no I/O.

export const SITE_TO_DOMAIN = new Map([
  ['us1', 'mcp.datadoghq.com'],
  ['us3', 'mcp.us3.datadoghq.com'],
  ['us5', 'mcp.us5.datadoghq.com'],
  ['eu', 'mcp.datadoghq.eu'],
  ['ap1', 'mcp.ap1.datadoghq.com'],
  ['ap2', 'mcp.ap2.datadoghq.com'],
]);

export const SITE_TABLE = [
  '| Site | MCP domain |',
  '| ---- | ---------- |',
  ...Array.from(SITE_TO_DOMAIN.entries()).map(([site, domain]) => `| ${site} | ${domain} |`),
].join('\n');

// Matches a bare hostname: letters/digits/hyphens separated by dots, at least
// one dot, no scheme/path/query/fragment/port/userinfo/whitespace.
const BARE_HOSTNAME_RE =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/i;

export const isBareHostname = (value: string): boolean => BARE_HOSTNAME_RE.test(value);

export const domainToSite = (domain: string): string | undefined => {
  for (const [site, d] of SITE_TO_DOMAIN) {
    if (d === domain) return site;
  }
  return undefined;
};

export const isKnownDomain = (domain: string): boolean => domainToSite(domain) !== undefined;

export const resolveSiteToDomain = (input: string): string | undefined => {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return undefined;

  const fromSite = SITE_TO_DOMAIN.get(trimmed);
  if (fromSite) return fromSite;

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    let host: string;
    try {
      host = new URL(trimmed).hostname;
    } catch {
      return undefined;
    }
    // Specific-subdomain sites first — us1/eu are broad suffixes that would
    // swallow us3/us5/ap1/ap2 hosts if checked via the same endsWith rule.
    for (const code of ['us3', 'us5', 'ap1', 'ap2']) {
      const domain = SITE_TO_DOMAIN.get(code);
      if (domain && host.endsWith(domain.replace(/^mcp\./, ''))) return domain;
    }
    if (host.endsWith('datadoghq.eu')) return SITE_TO_DOMAIN.get('eu');
    if (host.endsWith('datadoghq.com')) return SITE_TO_DOMAIN.get('us1');
    return undefined;
  }

  for (const [, domain] of SITE_TO_DOMAIN) {
    if (trimmed === domain) return domain;
  }

  if (isBareHostname(trimmed)) return trimmed;
  return undefined;
};
