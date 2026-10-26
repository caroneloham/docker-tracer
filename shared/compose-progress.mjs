export function visibleComposeProgress(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const layerId = (line) =>
    line.match(
      /^([a-f0-9]{12})\s+(?:Downloading|Extracting|Download complete|Pull complete|Already exists)\b/,
    )?.[1];
  const latest = new Map();
  lines.forEach((line, i) => {
    const id = layerId(line);
    if (id) latest.set(id, i);
  });
  return lines.filter((line, i) => !layerId(line) || latest.get(layerId(line)) === i).join('\n');
}
