export interface ParsedPage {
  id: number;
  label: string;
  selected: boolean;
}

/** Parses the `## Pages` block of a list_pages response: `0: Title (url) [selected]`. */
export function parsePages(text: string): ParsedPage[] {
  const pages: ParsedPage[] = [];
  let inSection = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("## ")) {
      inSection = line === "## Pages";
      continue;
    }
    if (!inSection) continue;
    const match = /^(\d+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const label = match[2] ?? "";
    pages.push({
      id: Number(match[1]),
      label: label.replace(/\s*\[selected\]\s*$/, "").trim(),
      selected: label.includes("[selected]"),
    });
  }
  return pages;
}

export interface ParsedExtension {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
}

/** Parses list_extensions lines: `id=<id> "<name>" v<version> Enabled`. */
export function parseExtensions(text: string): ParsedExtension[] {
  const extensions: ParsedExtension[] = [];
  const pattern = /^id=(\S+)\s+"(.*)"\s+v(\S+)\s+(Enabled|Disabled)$/;
  for (const rawLine of text.split("\n")) {
    const match = pattern.exec(rawLine.trim());
    if (!match) continue;
    extensions.push({
      id: match[1]!,
      name: match[2]!,
      version: match[3]!,
      enabled: match[4] === "Enabled",
    });
  }
  return extensions;
}

/** Extracts the URL from a page label of the form `Title (https://example.com/)`. */
export function urlFromPageLabel(label: string): string {
  const match = /\((https?:\/\/[^)]*|about:[^)]*|chrome:[^)]*)\)\s*$/.exec(label);
  if (match) return match[1]!;
  return label;
}
