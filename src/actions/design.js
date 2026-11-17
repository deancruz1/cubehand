import { ok } from './util.js';
import { guideFor } from '../designguide.js';

// The design guide for what is about to be built, fetched only when designing so the system
// prompt stays short.
export async function designGuide(ctx, { structure, style } = {}) {
  return ok(guideFor({ structure, style }));
}
