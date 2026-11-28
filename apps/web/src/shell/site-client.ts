import { createClient } from '@supabase/supabase-js';
import type { Database } from '@neckardt/backend/database';
import { makeSiteClientGetter, readPublicSupabaseConfig } from './browser-auth.mts';

declare const __SITE_PUBLIC_CONFIG__: unknown;
export const siteConfig = readPublicSupabaseConfig(typeof __SITE_PUBLIC_CONFIG__ === 'undefined' ? null : __SITE_PUBLIC_CONFIG__);

// Shell and features share one SDK client per project within this page. Separate
// pages retain the SDK's project-based persisted session key.
export const getSiteClient = makeSiteClientGetter(createClient<Database>);
