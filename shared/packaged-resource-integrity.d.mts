export interface PackagedResourceRequirement {
  label: string;
  path: string;
  suffix?: string;
}

export const PACKAGED_RESOURCE_REQUIREMENTS: readonly PackagedResourceRequirement[];
export function findMissingPackagedResources(resourcesRoot: string): string[];
export function describeIncompletePackagedResources(missing: readonly string[]): string;
