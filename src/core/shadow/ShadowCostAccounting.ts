import { ShadowCostScenario } from './ShadowTradingTypes';

export function netBpsByScenario(
  grossBps: number,
  scenarios: Record<string, ShadowCostScenario>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(scenarios).map(([name, scenario]) => [
      name,
      grossBps - scenario.feeBps - scenario.additionalSlippageBps,
    ]),
  );
}
