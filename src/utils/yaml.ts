import { parse, stringify } from "yaml";

/** Parse frontmatter without exposing the YAML implementation to domain code. */
export function parseYaml(input: string): unknown {
  return parse(input);
}

/** Produce stable, human-readable frontmatter without aliases or line folding. */
export function stringifyYaml(input: unknown): string {
  return stringify(input, {
    aliasDuplicateObjects: false,
    lineWidth: 0
  }).trimEnd();
}
