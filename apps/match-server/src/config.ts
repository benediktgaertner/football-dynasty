/**
 * O4: Konfiguration ausschließlich aus Umgebungsvariablen. Fehlende Pflichtwerte
 * führen zu einem klaren Startfehler statt zu stillem Fehlverhalten.
 */
export interface ServerConfig {
  port: number;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  allowedOrigins: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`Fehlende Umgebungsvariablen: ${missing.join(', ')} (siehe .env.example)`);
  }
  return {
    port: Number(env.PORT ?? 2567),
    supabaseUrl: env.SUPABASE_URL!.trim().replace(/\/+$/, ''),
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY!.replace(/\s+/g, ''),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? 'http://localhost:5173')
      .split(',')
      .map((o) => o.trim().replace(/\/+$/, ''))
      .filter(Boolean),
  };
}
