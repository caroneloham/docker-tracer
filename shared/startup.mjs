import { z } from 'zod';
export const startupSchema = z
  .object({
    mode: z.enum(['none', 'running', 'health', 'tcp', 'http']).default('none'),
    port: z.number().int().min(1).max(65535).default(80),
    path: z
      .string()
      .max(1024)
      .regex(/^\/[^\s\x00-\x1f\x7f]*$/)
      .default('/'),
    expectedStatus: z.number().int().min(100).max(599).default(200),
    timeoutSeconds: z.number().int().min(5).max(120).default(30),
  })
  .default({ mode: 'none', port: 80, path: '/', expectedStatus: 200, timeoutSeconds: 30 });
export const startupLabels = {
  none: 'Sans contrôle',
  running: 'Processus stable',
  health: 'Santé de l’image',
  tcp: 'Port TCP ouvert',
  http: 'Réponse HTTP',
};
export const startupDescription = (input) => {
  const s = startupSchema.parse(input);
  return (
    startupLabels[s.mode] +
    (s.mode === 'tcp'
      ? ' · :' + s.port
      : s.mode === 'http'
        ? ' ' + s.expectedStatus + ' · :' + s.port + s.path
        : '')
  );
};
export function assertStartupSupport(topology, capabilities) {
  if (
    topology?.nodes?.some((n) => n.data?.startup?.mode && n.data.startup.mode !== 'none') &&
    capabilities?.startupChecks !== true
  )
    throw Error(
      'Redémarre Docker Tracer pour activer les contrôles de démarrage. Le serveur ouvert ne les prend pas encore en charge.',
    );
}
