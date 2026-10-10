import { useEffect, useId, useState } from "react";
import type { Agent, BudgetPolicySummary, BudgetPolicyUpsertInput } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export interface BudgetCreationScope {
  key: string;
  scopeType: "company" | "agent";
  scopeId: string;
  label: string;
}

const MAX_BUDGET_CENTS = 2_147_483_647;

/** Budgets of $0 are stored as inactive and never block work, so creation requires a positive amount. */
export function parsePositiveUsdToCents(value: string): number | null {
  const normalized = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const cents = Math.round(Number(normalized) * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > MAX_BUDGET_CENTS) return null;
  return cents;
}

/**
 * Scopes that can receive a first monthly billed-cents policy: the organization and each live agent without one.
 * The server keys policies by scope, metric and window, so other windows (e.g. lifetime) do not count as coverage.
 */
export function budgetCreationScopes(
  companyId: string,
  policies: Pick<BudgetPolicySummary, "scopeType" | "scopeId" | "metric" | "windowKind">[],
  agents: Pick<Agent, "id" | "name" | "status">[],
): BudgetCreationScope[] {
  const covered = new Set(
    policies
      .filter((policy) => policy.metric === "billed_cents" && policy.windowKind === "calendar_month_utc")
      .map((policy) => `${policy.scopeType}:${policy.scopeId}`),
  );
  const scopes: BudgetCreationScope[] = [];
  if (!covered.has(`company:${companyId}`)) {
    scopes.push({ key: `company:${companyId}`, scopeType: "company", scopeId: companyId, label: "Organization" });
  }
  for (const agent of agents) {
    if (agent.status === "terminated" || covered.has(`agent:${agent.id}`)) continue;
    scopes.push({ key: `agent:${agent.id}`, scopeType: "agent", scopeId: agent.id, label: `Agent: ${agent.name}` });
  }
  return scopes;
}

export function BudgetPolicyCreateCard({
  scopes,
  preferredScopeKey,
  isSaving,
  onCreate,
}: {
  scopes: BudgetCreationScope[];
  preferredScopeKey?: string | null;
  isSaving?: boolean;
  onCreate: (input: BudgetPolicyUpsertInput) => void;
}) {
  const scopeFieldId = useId();
  const amountErrorId = useId();
  const initialKey = scopes.find((scope) => scope.key === preferredScopeKey)?.key ?? scopes[0]?.key ?? "";
  const [scopeKey, setScopeKey] = useState(initialKey);
  const [scopeChosen, setScopeChosen] = useState(false);
  const [amount, setAmount] = useState("");
  const [blockUnpriced, setBlockUnpriced] = useState(true);

  // Agents can load after the form mounts; follow the preferred scope until the operator picks one,
  // so an agent's budgets link never silently targets the organization.
  useEffect(() => {
    if (!scopeChosen || !scopes.some((scope) => scope.key === scopeKey)) setScopeKey(initialKey);
  }, [initialKey, scopeChosen, scopeKey, scopes]);

  const selected = scopes.find((scope) => scope.key === scopeKey);
  const amountCents = parsePositiveUsdToCents(amount);
  const showAmountError = amount.trim().length > 0 && amountCents === null;

  return (
    <Card>
      <CardHeader className="px-5 pt-5 pb-3">
        <CardTitle className="text-base">Create budget policy</CardTitle>
        <CardDescription>
          Monthly UTC hard stop. New work is blocked once observed spend reaches the amount; a run already in progress can
          finish above it. A $0 budget turns enforcement off, so use the smallest amount you accept (for example $0.01)
          when no spend is intended.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-5 pb-5 pt-0">
        <label htmlFor={scopeFieldId} className="block space-y-1 text-sm">
          <span>Scope</span>
          <select
            id={scopeFieldId}
            aria-label="Budget scope"
            className="block w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            value={scopeKey}
            onChange={(event) => {
              setScopeChosen(true);
              setScopeKey(event.target.value);
            }}
          >
            {scopes.map((scope) => <option key={scope.key} value={scope.key}>{scope.label}</option>)}
          </select>
        </label>
        <label className="block space-y-1 text-sm">
          <span>Monthly budget (USD)</span>
          <Input
            aria-label="Monthly budget (USD)"
            aria-invalid={showAmountError}
            aria-describedby={showAmountError ? amountErrorId : undefined}
            inputMode="decimal"
            placeholder="0.01"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>
        {showAmountError && (
          <p id={amountErrorId} role="alert" className="text-xs text-destructive">
            Enter an amount greater than $0 with at most two decimals.
          </p>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={blockUnpriced} onChange={(event) => setBlockUnpriced(event.target.checked)} />
          Block new work when usage has no reliable price
        </label>
        <Button
          disabled={isSaving || !selected || amountCents === null}
          onClick={() => {
            if (!selected || amountCents === null) return;
            onCreate({
              scopeType: selected.scopeType,
              scopeId: selected.scopeId,
              metric: "billed_cents",
              windowKind: "calendar_month_utc",
              amount: amountCents,
              hardStopEnabled: true,
              unpricedUsagePolicy: blockUnpriced ? "block" : "allow",
            });
          }}
        >
          Create budget policy
        </Button>
      </CardContent>
    </Card>
  );
}
