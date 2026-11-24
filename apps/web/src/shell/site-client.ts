import { createClient } from '@supabase/supabase-js';
import type { Database } from '@neckardt/backend/database';
import { makeSiteClientGetter } from './browser-auth.mts';

// Shell and features share one SDK client per project within this page. Separate
// pages retain the SDK's project-based persisted session key.
export const getSiteClient = makeSiteClientGetter(createClient<Database>);
