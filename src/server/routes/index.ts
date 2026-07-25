import { Express } from 'express';
import { createHealthRoutes, HealthRoutesDeps } from './health.js';
import { createSessionRoutes, SessionRoutesDeps } from './sessions.js';
import { createFolderRoutes, FolderRoutesDeps } from './folders.js';
import { createUpdateRoutes, UpdateRoutesDeps } from './update.js';
import { createPasteRoutes, PasteRoutesDeps } from './paste.js';
import { createProfileRoutes, ProfileRoutesDeps } from './profiles.js';

export interface RegisterRoutesDeps
  extends HealthRoutesDeps,
    SessionRoutesDeps,
    FolderRoutesDeps,
    UpdateRoutesDeps,
    PasteRoutesDeps,
    ProfileRoutesDeps {}

export function registerRoutes(app: Express, deps: RegisterRoutesDeps): void {
  app.use(createHealthRoutes(deps));
  app.use(createSessionRoutes(deps));
  app.use(createFolderRoutes(deps));
  app.use(createUpdateRoutes(deps));
  app.use(createPasteRoutes(deps));
  app.use(createProfileRoutes(deps));
}
