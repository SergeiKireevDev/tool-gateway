'use client';

import { EGRESS_PRESETS, parseDomains } from '@/lib/egress';
import { Button, Field, Textarea } from './ui';

/** A template's internet access for agents: HTTPS domains, with package registry presets. */
export function EgressDomainsField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const domains = parseDomains(value);
  const add = (preset: readonly string[]): void => {
    const missing = preset.filter((d) => !domains.includes(d));
    onChange([...domains, ...missing].join('\n'));
  };

  return (
    <fieldset className="space-y-2">
      <legend className="mb-2 text-sm font-medium text-slate-700">
        Internet access{' '}
        <span className="font-normal text-slate-500">
          (for agents: HTTPS domains they may reach directly; empty = none)
        </span>
      </legend>
      <div className="flex flex-wrap gap-1.5">
        {Object.entries(EGRESS_PRESETS).map(([name, preset]) => (
          <Button
            key={name}
            variant="secondary"
            size="sm"
            disabled={preset.every((d) => domains.includes(d))}
            onClick={() => {
              add(preset);
            }}
          >
            + {name}
          </Button>
        ))}
      </div>
      <Field
        label="Allowed domains"
        hint="One per line: example.com (that host only) or *.example.com (its subdomains). The gateway sees the domain, not the requests: each domain is a place an agent can send data to. Services the gateway brokers (GitHub, Slack, model APIs…) can't be listed: grant their tool instead."
      >
        <Textarea
          rows={3}
          value={value}
          placeholder="registry.npmjs.org"
          onChange={(e) => {
            onChange(e.target.value);
          }}
        />
      </Field>
    </fieldset>
  );
}
