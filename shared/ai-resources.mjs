// Limits are ceilings, not reservations. Leave room for the OS, Docker and the
// other services; vLLM's fraction is relative to each GPU's total VRAM.
export function automaticAiResources(report, values) {
  const ram = Number(report?.ramGiB);
  const cpus = Number(report?.cpus);
  const webRam = Number(values.webRamGiB);
  if (
    !Number.isFinite(ram) ||
    ram < 8 ||
    !Number.isFinite(cpus) ||
    cpus < 1 ||
    !Number.isFinite(webRam) ||
    webRam < 2
  )
    return null;
  const gpus = report?.hardware?.gpus || [];
  const selected = (values.gpuIds || []).map((id) =>
    gpus.find((gpu) => gpu.uuid === id || String(gpu.index) === String(id)),
  );
  if (
    !selected.length ||
    selected.some((gpu) => !gpu || !(gpu.totalGiB > 0) || !Number.isFinite(gpu.freeGiB))
  )
    return null;
  const fractions = selected.map((gpu) =>
    Math.min(0.9, (gpu.freeGiB - Math.max(1, gpu.totalGiB * 0.05)) / gpu.totalGiB),
  );
  const gpuMemory = Math.floor(Math.min(...fractions) * 100) / 100;
  const inferenceRamGiB = Math.floor(ram - webRam - Math.max(2, ram * 0.1));
  if (gpuMemory < 0.1 || inferenceRamGiB < 2) return null;
  return {
    ramGiB: ram,
    inferenceCpus: Math.floor(cpus),
    inferenceRamGiB,
    shmGiB: Math.min(values.shmGiB || 4, Math.max(1, Math.floor(inferenceRamGiB / 2))),
    gpuMemory,
    vramGiB: Math.min(...selected.map((gpu) => gpu.totalGiB)),
  };
}
