/** GitHub codespace regions, as `location` names them, with a short label for people. */
const REGION_LABELS: Record<string, string> = {
  CentralIndia: "India",
  SouthEastAsia: "Southeast Asia",
  EastUs: "US East",
  WestUs2: "US West",
  WestEurope: "Europe West",
};

/** A short label for a GitHub region. An unknown region shows its GitHub name. */
export function regionLabel(location: string | null | undefined): string | null {
  if (!location) return null;
  return REGION_LABELS[location] ?? location;
}
