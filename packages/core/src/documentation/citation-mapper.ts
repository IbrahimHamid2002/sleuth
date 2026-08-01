const CITATION_PATTERN = /`(\w+)`/g;

export function mapCitations(generatedText: string, symbolIndex: Map<string, Array<{ path: string; line: number }>>): string {
  return generatedText.replace(CITATION_PATTERN, (match, identifier: string) => {
    const firstLocation = symbolIndex.get(identifier)?.[0];

    if (firstLocation === undefined) {
      return match;
    }

    return `${match} [${firstLocation.path}:${firstLocation.line}]`;
  });
}
