import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import { missingEnv } from './lib/supabase';
import { Card, Shell, Spinner } from './components/ui';
import { Account } from './pages/Account';
import { ClubEditor } from './pages/ClubEditor';
import { Home } from './pages/Home';
import { Lobby } from './pages/Lobby';
import { Welcome } from './pages/Welcome';

function Routed() {
  const { loading, session, profile } = useAuth();
  if (loading) return <Spinner label="Verbinde …" />;
  if (!session || !profile) return <Welcome />;
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/konto" element={<Account />} />
      <Route path="/w/:worldId" element={<Lobby />} />
      <Route path="/w/:worldId/verein" element={<ClubEditor />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/** O4: Ohne Zugangsdaten zeigt die App genau an, was fehlt – statt Funktionen vorzutäuschen. */
function ConfigMissing() {
  return (
    <Shell>
      <Card className="mx-auto max-w-xl">
        <h1 className="display text-3xl font-bold uppercase">Konfiguration fehlt</h1>
        <p className="mt-3 text-cream-dim">Folgende Umgebungsvariablen sind nicht gesetzt (siehe .env.example und DEPLOYMENT.md):</p>
        <ul className="mt-3 list-inside list-disc font-mono text-gold">
          {missingEnv.map((v) => (
            <li key={v}>{v}</li>
          ))}
        </ul>
      </Card>
    </Shell>
  );
}

export function App() {
  if (missingEnv.length > 0) return <ConfigMissing />;
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routed />
      </AuthProvider>
    </BrowserRouter>
  );
}
