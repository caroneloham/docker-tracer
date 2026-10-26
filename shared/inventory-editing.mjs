// Docker names and IP addresses are not globally unique. Only route an equipment
// to an editor when its owning project and host identify one managed project.
export function findEditableProject(container, projects) {
  if (!container || container.isProbe || !container.service) return null;
  const key = container.originalProjectKey || '';
  const composeName = key.startsWith('compose:') ? key.slice(8) : null;
  const matches = projects.filter((project) => {
    if (project.archivedAt || project.hostId !== container.hostId) return false;
    return project.kind === 'compose'
      ? !!composeName && project.composeProjectName === composeName
      : !!container.labId && project.id === container.labId;
  });
  if (matches.length !== 1) return null;
  const project = matches[0];
  return {
    project,
    nodeId: project.kind === 'compose' ? `service:${container.service}` : container.service,
  };
}
