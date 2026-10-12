'use client';

import { type CallResult, callOutcome, OUTCOME_BADGES } from '@/lib/activity';
import { Badge } from './ui';

/** A proxied call's result: green when it succeeded, amber when the target failed, red when denied. */
export function CallBadge({ call }: { call: CallResult }) {
  const b = OUTCOME_BADGES[callOutcome(call)];
  return (
    <Badge tone={b.tone}>
      <span aria-hidden className="mr-1">
        {b.icon}
      </span>
      {b.label} {call.status}
    </Badge>
  );
}
