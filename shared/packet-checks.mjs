export function packetChecks(p) {
  const checks = [],
    t = p.layers?.transport || {},
    a = p.layers?.application || {};
  const add = (message, level = 'info') => checks.push({ message, level });
  if (p.route?.length)
    add('Le trajet est associé à un réseau commun identifié par les adresses IP.');
  else add('Le trajet de ce paquet n’est pas déterminé sur le schéma.');
  if (t.flags && (Number.parseInt(t.flags, 16) || 0) & 4)
    add('TCP RST : un équipement réinitialise ou refuse la connexion.', 'alert');
  if (t.icmpType === '3')
    add(`ICMP : destination inaccessible (code ${t.icmpCode || 'non décodé'}).`, 'alert');
  if (t.icmpType === '11') add('ICMP : délai dépassé, notamment en cas de TTL épuisé.', 'alert');
  if (a.status) add(`Réponse HTTP ${a.status}.`, Number(a.status) >= 400 ? 'alert' : 'info');
  if (/retransmission/i.test(p.info || ''))
    add(
      'TShark signale une retransmission ; ce seul paquet ne permet pas d’en établir la cause.',
      'alert',
    );
  if (p.layers?.network?.ttl === '1')
    add('TTL égal à 1 : ce paquet ne peut pas franchir un routeur supplémentaire.');
  return checks;
}
