import { describe, expect, it } from "vitest";
import { budgetCreationScopes, parsePositiveUsdToCents } from "./BudgetPolicyCreateCard";

describe("parsePositiveUsdToCents", () => {
  it.each([
    ["0.01", 1],
    ["5", 500],
    [" 12.50 ", 1250],
    ["21474836.47", 2_147_483_647],
  ])("accepts %s as %s cents", (input, cents) => {
    expect(parsePositiveUsdToCents(input)).toBe(cents);
  });

  it.each(["", "0", "0.00", "-0.01", "1.005", "1e3", "abc", "21474836.48"])("rejects %s", (input) => {
    expect(parsePositiveUsdToCents(input)).toBeNull();
  });
});

describe("budgetCreationScopes", () => {
  const agents = [
    { id: "a1", name: "Covered", status: "idle" as const },
    { id: "a2", name: "Open", status: "paused" as const },
    { id: "a3", name: "Gone", status: "terminated" as const },
  ];

  it("offers the organization and uncovered live agents only", () => {
    expect(budgetCreationScopes("c1", [{ scopeType: "agent", scopeId: "a1" }], agents).map((scope) => scope.key))
      .toEqual(["company:c1", "agent:a2"]);
  });

  it("omits the organization once it has a policy", () => {
    expect(budgetCreationScopes("c1", [{ scopeType: "company", scopeId: "c1" }], []).length).toBe(0);
  });
});
