import { Express } from 'express';
import { createHealthRoutes, HealthRoutesDeps } from './health.js';
import { createSessionRoutes, SessionRoutesDeps } from './sessions.js';
import { createFolderRoutes, FolderRoutesDeps } from './folders.js';
import { createUpdateRoutes, UpdateRoutesDeps } from './update.js';
import { createPasteRoutes, PasteRoutesDeps } from './paste.js';
import { createChatAttachmentRoutes, ChatAttachmentRoutesDeps } from './chat-attachments.js';
import { createProfileRoutes, ProfileRoutesDeps } from './profiles.js';
import { createPreferenceRoutes, PreferenceRoutesDeps } from './preferences.js';
import { createWorkspaceRoutes, WorkspaceRoutesDeps } from './workspace.js';
import { createEnvironmentRoutes, EnvironmentRoutesDeps } from './environment.js';
import { createUsageRoutes, UsageRoutesDeps } from './usage.js';
import { createDeployTargetRoutes, DeployTargetRoutesDeps } from './deploy-targets.js';
import { createProjectRoutes, ProjectsRoutesDeps } from './projects.js';
import { createConnectedHostRoutes, ConnectedHostRoutesDeps } from './connected-hosts.js';
import { createGitIdentityRoutes, GitIdentityRoutesDeps } from './git-identity.js';
import { createStorageUsageRoutes, StorageUsageRoutesDeps } from './storage-usage.js';
import { createAgentMaintenanceRoutes, AgentMaintenanceRoutesDeps } from './agent-maintenance.js';

export type RegisterRoutesDeps = HealthRoutesDeps
  & SessionRoutesDeps
  & FolderRoutesDeps
  & UpdateRoutesDeps
  & PasteRoutesDeps
  & ChatAttachmentRoutesDeps
  & ProfileRoutesDeps
  & PreferenceRoutesDeps
  & WorkspaceRoutesDeps
  & UsageRoutesDeps
  & EnvironmentRoutesDeps
  & DeployTargetRoutesDeps
  & ProjectsRoutesDeps
  & ConnectedHostRoutesDeps
  & GitIdentityRoutesDeps
  & StorageUsageRoutesDeps
  & AgentMaintenanceRoutesDeps;

export function registerRoutes(app: Express, deps: RegisterRoutesDeps): void {
  app.use(createHealthRoutes(deps));
  app.use(createSessionRoutes(deps));
  app.use(createFolderRoutes(deps));
  app.use(createUpdateRoutes(deps));
  app.use(createPasteRoutes(deps));
  app.use(createChatAttachmentRoutes(deps));
  app.use(createProfileRoutes(deps));
  app.use(createPreferenceRoutes(deps));
  app.use(createWorkspaceRoutes(deps));
  app.use(createUsageRoutes(deps));
  app.use(createEnvironmentRoutes(deps));
  app.use(createDeployTargetRoutes(deps));
  app.use(createProjectRoutes(deps));
  app.use(createConnectedHostRoutes(deps));
  app.use(createGitIdentityRoutes(deps));
  app.use(createStorageUsageRoutes(deps));
  app.use(createAgentMaintenanceRoutes(deps));
}
