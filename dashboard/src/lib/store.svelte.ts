// The service catalog, shared by every page (loaded by App, edited on the
// Services page, used by the quote editor and client pages).
import type { ServiceCategory, ServiceRow } from "./types.ts";

export const catalog = $state({ categories: [] as ServiceCategory[], services: [] as ServiceRow[] });
