const segment = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
const repositoryPattern = new RegExp(`^${segment}(?:/${segment})?$`);

export function hubRepository(value) {
  if (typeof value !== 'string' || value.length > 180 || !repositoryPattern.test(value))
    throw Error('Indique un dépôt Docker Hub, par exemple nginx ou linuxserver/sonarr.');
  const canonical = value.includes('/') ? value : `library/${value}`;
  return { canonical, display: canonical.replace(/^library\//, '') };
}

export function imageReference(value) {
  const image = typeof value === 'string' ? value.trim() : '';
  if (!image || image.length > 255 || /\s|:\/\/|[\\?#$]/.test(image))
    throw Error(
      'Indique une image, par exemple nginx:alpine ou ghcr.io/organisation/image:version.',
    );
  const [beforeDigest, digest, extra] = image.split('@');
  if (extra !== undefined || (digest !== undefined && !/^sha256:[a-fA-F0-9]{64}$/.test(digest)))
    throw Error('Le digest doit être de la forme sha256 suivi de 64 caractères hexadécimaux.');
  const lastSlash = beforeDigest.lastIndexOf('/'),
    lastColon = beforeDigest.lastIndexOf(':');
  const tagged = lastColon > lastSlash;
  const name = tagged ? beforeDigest.slice(0, lastColon) : beforeDigest;
  const tag = tagged ? beforeDigest.slice(lastColon + 1) : '';
  if (tagged && !/^[\w][\w.-]{0,127}$/.test(tag)) throw Error('Cette version Docker est invalide.');
  const parts = name.split('/');
  if (
    parts.length > 1 &&
    (parts[0].includes('.') || parts[0].includes(':') || parts[0] === 'localhost')
  ) {
    if (!/^[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*(?::[0-9]{1,5})?$/.test(parts.shift()))
      throw Error('Le nom du registre est invalide.');
  }
  if (!parts.length || parts.some((part) => !new RegExp(`^${segment}$`).test(part)))
    throw Error('Le nom de l’image doit être en minuscules, sans espaces.');
  return tagged || digest ? image : `${image}:latest`;
}
