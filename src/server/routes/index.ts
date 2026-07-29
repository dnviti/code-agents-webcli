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
import { createUsageRoutes, UsageRoutesDeps } from './usage.js';

export interface RegisterRoutesDeps
  extends HealthRoutesDeps,
    SessionRoutesDeps,
    FolderRoutesDeps,
    UpdateRoutesDeps,
    PasteRoutesDeps,
    ChatAttachmentRoutesDeps,
    ProfileRoutesDeps,
    PreferenceRoutesDeps,
    WorkspaceRoutesDeps,
    UsageRoutesDeps {}

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
}
